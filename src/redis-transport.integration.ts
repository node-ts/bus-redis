import { RedisTransport } from './redis-transport'
import { RedisTransportConfiguration } from './redis-transport-configuration'
import { HandleChecker, TestCommand, TestSystemMessage, transportTests } from '@node-ts/bus-test'
import { Bus, BusInstance, DefaultHandlerRegistry, handlerFor, JsonSerializer, MessageSerializer, sleep } from '@node-ts/bus-core'
import { Connection, ModestQueue } from 'modest-queue'
import { Message, MessageAttributes } from '@node-ts/bus-messages'
import { Mock } from 'typemoq'
import { EventEmitter } from 'stream'
import uuid from 'uuid'

const configuration: RedisTransportConfiguration = {
  queueName: 'node-ts/bus-redis-test',
  connectionString: 'redis://127.0.0.1:6379',
  maxRetries: 10
}

describe('RedisTransport', () => {
  jest.setTimeout(30000)

  const redisTransport = new RedisTransport(configuration)
  const messageSerializer = new MessageSerializer(
    new JsonSerializer(),
    new DefaultHandlerRegistry()
  )

  async function purgeQueue() {
    const modestQueue = new ModestQueue({
      queueName: configuration.queueName,
      connectionString: configuration.connectionString,
      withScheduler: false,
      withDelayedScheduler: false
    })
    await modestQueue.initialize()
    await modestQueue.destroyQueue()
    await modestQueue.dispose()
  }

  const systemMessageTopicIdentifier = TestSystemMessage.NAME
  const message = new TestSystemMessage()

  const publishSystemMessage = async (systemMessageAttribute: string) => {
    const attributes = { systemMessage: systemMessageAttribute }

    const payload = {
      message: messageSerializer.serialize(message),
      correlationId: undefined,
      attributes: attributes,
      stickyAttributes: {}
    }

    redisTransport['queue'].publish(JSON.stringify(payload))
  }
  /**
   * pops all messages from the DLQ recursively until there are no more
   */
  async function pullAllFromDLQ(messages = []): Promise<{ message: Message, attributes: MessageAttributes}[]> {
    const modestQueue = redisTransport['queue']
    const dlqAddress = modestQueue['deadLetterQueue']
    const redisConnection = modestQueue['connection'] as Connection
    const queueStats = await modestQueue.queueStats()
    if (queueStats.dlq === 0) {
      return messages.map(msg => {
        const rawMessage = JSON.parse(msg)
        const { message, ...attributes} = JSON.parse(rawMessage.message)
        const domainMessage = JSON.parse(message)
        const dlqMessage =  {
          message: domainMessage,
          attributes
        }
        return dlqMessage
      })
    }
    const message = await redisConnection.lpop(dlqAddress)
    return pullAllFromDLQ(messages.concat(message))
  }

  const readAllFromDeadLetterQueue = async () => {
    // required so that there is time for the message to be put on the dlq after retries
    await sleep(1000)
    const allFromDLQ = await pullAllFromDLQ()
    return allFromDLQ
  }

  beforeAll(async () => {
    await purgeQueue()
  })

  transportTests(
    redisTransport,
    publishSystemMessage,
    systemMessageTopicIdentifier,
    readAllFromDeadLetterQueue
  )

  describe("when a queue has subscribed to a message of interest but the queue is not accessible to be published to", () => {
    let bus: BusInstance
    beforeAll(async () => {
      bus = await Bus.configure()
        .withTransport(redisTransport)
        .withHandler(handlerFor(
          TestCommand,
          () => {}
        ))
        .initialize()

      await bus.start()
    })
    afterAll(async () => {
      await bus.dispose()
    })
    it('fails when publishing a message', async () => {
      // spy on zadd, which is how the underlying queue lib pushes messages to a queue
      const queuePushSpy = jest.spyOn(redisTransport['connection'], 'zadd')
      // make it fail for the 3 attempts that a message will try to publish
      queuePushSpy
        .mockImplementationOnce(() => {throw new Error('zadd failed 1st')})
        .mockImplementationOnce(() => {throw new Error('zadd failed 2nd')})
        .mockImplementationOnce(() => {throw new Error('zadd failed 3rd')})

      const testCommand = new TestCommand(uuid.v4(), new Date())
      const messageOptions: MessageAttributes = {
        correlationId: uuid.v4(),
        attributes: {
          attribute1: 'a',
          attribute2: 1
        },
        stickyAttributes: {
          attribute1: 'b',
          attribute2: 2
        }
      }
      // send and expect it to throw an error with the message it failed to send
      await expect(bus.send(testCommand, messageOptions)).rejects.toThrow(/^Failed to publish message.*/)
      queuePushSpy.mockClear()
    })
  })
})
