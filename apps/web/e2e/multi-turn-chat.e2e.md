# E2E Test: Multi-Turn Chat with kimi-webbridge

> This test script is designed to be executed by the kimi-webbridge skill.
> Each scenario tests a specific aspect of the multi-turn conversation feature.
> Prerequisites: `pnpm dev` running (daemon on :3100, web on :5173)

---

## Scenario 1: Multi-Turn Context Memory (Core Test)

**Goal**: Verify that the agent remembers context from previous turns.

### Steps:

1. **Navigate** to `http://localhost:5173`
2. **Screenshot** the page to verify it loaded correctly
3. **Select Agent**: Click on the agent selector and choose "Claude Code" (or any available agent)
4. **Send first message**: Type "你好，我的名字是 Jack，请记住我的名字" in the input box and press Enter
5. **Wait for response**: Wait until the assistant message appears and streaming finishes (no more text_delta events). Maximum wait: 60 seconds.
6. **Verify first response**:
   - Screenshot the chat area
   - Confirm a user message bubble is visible with "你好，我的名字是 Jack"
   - Confirm an assistant message bubble is visible and non-empty
   - The assistant response should contain "Jack" or acknowledge remembering the name
7. **Send follow-up message**: Type "请问我的名字是什么？" in the input box and press Enter
8. **Wait for response**: Wait until the second assistant message finishes streaming. Maximum wait: 60 seconds.
9. **Verify context memory** (CRITICAL):
   - Screenshot the chat area
   - **The assistant's second response MUST contain "Jack"** — this proves multi-turn context is working
   - Verify there are now exactly 4 message bubbles: user → assistant → user → assistant
10. **Report**: Pass if "Jack" appears in the second assistant response, Fail otherwise

---

## Scenario 2: New Conversation

**Goal**: Verify that creating a new conversation resets the chat.

### Steps:

1. **Pre-condition**: Scenario 1 completed with messages in the chat
2. **Click** the "New Chat" button (or the new conversation icon)
3. **Verify**:
   - The chat area is empty (0 message bubbles)
   - The input box is ready for new input
4. **Send message**: Type "这是新对话的第一条消息" and press Enter
5. **Wait for response**: Wait for assistant response (max 60s)
6. **Verify**:
   - Only 2 message bubbles visible (1 user + 1 assistant)
   - Previous conversation's messages are NOT visible
7. **Report**: Pass if old messages are gone, Fail if they persist

---

## Scenario 3: Conversation Persistence (DB Round-trip)

**Goal**: Verify that messages survive a page refresh.

### Steps:

1. **Pre-condition**: A conversation with at least 2 rounds of messages
2. **Refresh the page** (navigate to `http://localhost:5173` again, or press F5)
3. **Wait** for the page to fully load
4. **Navigate** to the conversation list (sidebar) and select the previous conversation
5. **Verify**:
   - Messages from the previous session are restored
   - Message order is correct: user → assistant → user → assistant
   - Content matches what was sent/received before the refresh
6. **Report**: Pass if messages persist, Fail if they're lost

---

## Scenario 4: SSE Disconnect Recovery

**Goal**: Verify that buffered events allow SSE reconnection.

### Steps:

1. **Send a long message** that will take >5 seconds to complete (e.g., "写一个500字的关于人工智能的文章")
2. **Wait** for the assistant to start streaming (at least some text appears)
3. **Close the browser tab** (simulating disconnect)
4. **Re-open** `http://localhost:5173` in a new tab
5. **Navigate** to the same conversation
6. **Verify**:
   - If the run is still active, SSE reconnects and resumes streaming
   - Previously received text is not lost
   - The final assistant message contains the complete response
7. **Report**: Pass if no data loss, Fail if content is missing

---

## Execution Notes

- **kimi-webbridge** controls the user's real browser via the daemon
- Each step should be verified with screenshots where indicated
- Wait times should respect the 60-second maximum for agent responses
- If any step fails, capture a screenshot and report the failure details
- The test is considered **PASS** only if all scenarios pass
- The test is considered **FAIL** if any scenario fails
