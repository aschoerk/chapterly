Insert action is implemented in chat-node.component.ts as saveAsInsertAndSend().
It branches a new sibling question, streams an answer, then reparents the previous question and its siblings under that answer via ChatService.reparentNodes / LlmService.streamAnswer({ adoptNodeIds }).
