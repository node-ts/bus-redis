import { HandlesMessage } from '@node-ts/bus-core'
import { MessageAttributes } from '@node-ts/bus-messages'
import { TestPoisonedMessage } from './test-poisoned-message'
import { HANDLE_CHECKER, HandleChecker } from './handler-checker'
import { inject } from 'inversify'
@HandlesMessage(TestPoisonedMessage)
export class TestPoisonedMessageHandler {

  constructor (
    @inject(HANDLE_CHECKER) private readonly handleChecker: HandleChecker
  ) {
  }

  async handle (message: TestPoisonedMessage, messageAttributes: MessageAttributes): Promise<void> {
    this.handleChecker.check(message, messageAttributes)
    throw new Error('This will be routed to the failed queue after maxRetries')
  }
}
