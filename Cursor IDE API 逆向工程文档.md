# Cursor IDE API 逆向工程文档

> 最后更新: 2026-03-20  
> Cursor 版本: 2.6.20  
> 基于对 `workbench.desktop.main.js` 的完整逆向分析

---

## 目录

- [1. 架构概览](#1-架构概览)
- [2. 认证与请求头](#2-认证与请求头)
- [3. 协议详解](#3-协议详解)
- [4. API 服务定义](#4-api-服务定义)
- [5. AgentService.Run 完整流程](#5-agentservicerun-完整流程)
- [6. Protobuf 类型定义](#6-protobuf-类型定义)
- [7. 可用模型列表](#7-可用模型列表)
- [8. 凭证提取](#8-凭证提取)
- [9. Checksum 生成算法](#9-checksum-生成算法)
- [10. 完整工作示例](#10-完整工作示例)
- [11. 已知问题与注意事项](#11-已知问题与注意事项)

---

## 1. 架构概览

### 两套 API 体系

Cursor IDE 存在 **两套完全不同的 API 体系**：

| 特性 | 旧协议 (aiserver.v1) | 新协议 (agent.v1) ✅ |
|------|----------------------|----------------------|
| 包名 | `aiserver.v1` | `agent.v1` |
| 服务 | `ChatService` | `AgentService` |
| 状态 | 大部分已废弃 | **当前使用** |
| 主端点 | `StreamUnifiedChatWithTools` | `Run` |
| 流类型 | BiDi Streaming | BiDi Streaming |
| 复杂度 | 中等 | 高（需要处理 exec 消息） |

### 通信链路

```
IDE Client ──[gRPC/H2]──> 本地后端进程 (127.0.0.1:port) ──[H2]──> api2.cursor.sh
```

IDE 实际通过本地 gRPC 服务器中转，但我们可以直接调用 `api2.cursor.sh`。

---

## 2. 认证与请求头

### 必需请求头

| Header | 说明 | 示例值 |
|--------|------|--------|
| `authorization` | Bearer Token | `Bearer eyJhbG...` |
| `x-cursor-checksum` | 校验和（基于 machineId） | `base64...machineId/macMachineId` |
| `x-cursor-client-version` | 客户端版本号 | `2.6.20` |
| `x-request-id` | 请求唯一标识 (UUID v4) | `550e8400-e29b-41d4-a716-446655440000` |
| `content-type` | 内容类型 | `application/connect+json` |
| `connect-protocol-version` | ConnectRPC 版本 | `1` |

### 可选请求头

| Header | 说明 | 示例值 |
|--------|------|--------|
| `x-cursor-client-type` | 客户端类型 | `ide` |
| `x-cursor-client-os` | 操作系统 | `windows_nt` |
| `x-cursor-client-arch` | 架构 | `x64` |
| `x-cursor-client-device-type` | 设备类型 | `desktop` |
| `x-cursor-timezone` | 时区 | `Asia/Shanghai` |
| `x-ghost-mode` | 隐私模式 | `false` |
| `x-session-id` | 会话 ID | UUID |
| `x-client-key` | 客户端密钥(MCP加密) | AES-GCM JWK |

---

## 3. 协议详解

### ConnectRPC over HTTP/2

所有 API 调用使用 **ConnectRPC** 协议，基于 HTTP/2。

#### Unary 请求（如 GetUsableModels）

```
Content-Type: application/json
Body: JSON 对象
```

#### Streaming 请求（如 AgentService.Run）

```
Content-Type: application/connect+json
Body: Envelope 帧序列
```

### Envelope 帧格式

每个帧由 5 字节头 + 数据组成：

```
┌──────┬──────────────┬────────────────┐
│ Flag │   Length     │    Data        │
│ 1B   │   4B (BE)   │  N bytes       │
└──────┴──────────────┴────────────────┘
```

- **Flag**: `0x00` = 数据帧, `0x02` = 压缩帧
- **Length**: 大端序 uint32, 表示 Data 长度
- **Data**: JSON 编码的 protobuf 消息

### 编码示例 (Node.js)

```javascript
function writeFrame(req, obj) {
  const jsonStr = JSON.stringify(obj);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const frame = Buffer.alloc(5 + jsonBuf.length);
  frame[0] = 0; // flag
  frame.writeUInt32BE(jsonBuf.length, 1); // length
  jsonBuf.copy(frame, 5); // data
  req.write(frame);
}
```

### 解码示例 (Node.js)

```javascript
function parseFrames(buffer) {
  let offset = 0;
  const messages = [];
  while (offset + 5 <= buffer.length) {
    const flag = buffer[offset];
    const len = buffer.readUInt32BE(offset + 1);
    offset += 5;
    if (offset + len > buffer.length) break;
    const data = buffer.slice(offset, offset + len).toString('utf8');
    messages.push(JSON.parse(data));
    offset += len;
  }
  return messages;
}
```

---

## 4. API 服务定义

### agent.v1.AgentService ✅ (主要服务)

| 方法 | 类型 | 输入 | 输出 | 说明 |
|------|------|------|------|------|
| **Run** | BiDi Streaming | `AgentClientMessage` | `AgentServerMessage` | 主聊天方法 |
| **RunSSE** | Server Streaming | `BidiRequestId` | `AgentServerMessage` | SSE 变体 |
| **RunPoll** | Server Streaming | `BidiPollRequest` | `BidiPollResponse` | 轮询变体 |
| **GetUsableModels** | Unary | `{}` | `{models: [...]}` | 获取可用模型 |
| **NameAgent** | Unary | - | - | 为对话命名 |
| **GetDefaultModelForCli** | Unary | - | - | CLI 默认模型 |
| **GetAllowedModelIntents** | Unary | - | - | 模型意图权限 |

### aiserver.v1.ChatService (旧，大部分已废弃)

| 方法 | 类型 | 输入 | 输出 | 状态 |
|------|------|------|------|------|
| StreamUnifiedChat | Server Streaming | `StreamUnifiedChatRequest` | `StreamUnifiedChatResponse` | ❌ 已废弃 |
| StreamUnifiedChatWithTools | BiDi Streaming | `StreamUnifiedChatRequestWithTools` | `StreamUnifiedChatResponseWithTools` | ❌ Bad Request |
| StreamUnifiedChatWithToolsSSE | Server Streaming | `BidiRequestId` | Response | 需要加密密钥 |
| StreamUnifiedChatWithToolsPoll | Server Streaming | `BidiPollRequest` | `BidiPollResponse` | 需要加密密钥 |
| GetConversationSummary | Unary | `StreamUnifiedChatRequest` | Summary | - |
| GetPromptDryRun | Unary | `StreamUnifiedChatRequest` | DryRun | - |

### agent.v1.ControlService

| 方法 | 说明 |
|------|------|
| Ping | 心跳检测 |
| Exec | 执行命令 |
| ListDirectory | 列目录 |

### agent.v1.ExecService

| 方法 | 说明 |
|------|------|
| Exec | 远程执行 |

---

## 5. AgentService.Run 完整流程

### 流程图

```
Client                              Server (api2.cursor.sh)
  │                                      │
  │──── runRequest ──────────────────────>│  1. 发起请求
  │                                      │
  │<──── heartbeat ──────────────────────│  2. 心跳
  │<──── execServerMessage ──────────────│  3. 请求上下文
  │      (requestContextArgs)            │
  │                                      │
  │──── execClientMessage ──────────────>│  4. 回复上下文
  │      (requestContextResult.success)  │
  │                                      │
  │──── clientHeartbeat ────────────────>│  5. 客户端心跳 (每5秒)
  │                                      │
  │<──── kvServerMessage ────────────────│  6. KV 数据 (system/user prompt)
  │<──── kvServerMessage ────────────────│
  │                                      │
  │<──── interactionUpdate ──────────────│  7. 思考开始
  │      (thinkingDelta)                 │
  │<──── interactionUpdate ──────────────│  8. 思考完成
  │      (thinkingCompleted)             │
  │                                      │
  │<──── interactionUpdate ──────────────│  9. 文本流 ⭐
  │      (textDelta: "Hello World")      │
  │                                      │
  │<──── interactionUpdate ──────────────│  10. 回合结束
  │      (turnEnded: {tokens...})        │
  │                                      │
  │──── req.end() ──────────────────────>│  11. 关闭
```

### Step 1: 发送 runRequest

```json
{
  "runRequest": {
    "conversationState": {},
    "action": {
      "userMessageAction": {
        "userMessage": {
          "text": "你好"
        }
      }
    },
    "modelDetails": {
      "modelId": "composer-2",
      "displayName": "Composer 2",
      "displayNameShort": "Composer 2"
    },
    "requestedModel": {
      "modelId": "composer-2"
    },
    "conversationId": "uuid-v4"
  }
}
```

### Step 3-4: 处理 requestContextArgs

**收到:**
```json
{
  "execServerMessage": {
    "id": 0,
    "execId": "",
    "requestContextArgs": {}
  }
}
```

**回复:**
```json
{
  "execClientMessage": {
    "id": 0,
    "execId": "",
    "requestContextResult": {
      "success": {
        "requestContext": {
          "env": {
            "operatingSystem": "windows",
            "defaultShell": "powershell"
          }
        }
      }
    }
  }
}
```

### Step 5: 客户端心跳

```json
{
  "clientHeartbeat": {}
}
```

每 5 秒发送一次，保持连接活跃。

### Step 7-8: 思考过程

```json
// 思考开始
{"interactionUpdate": {"thinkingDelta": {"thinkingStyle": "THINKING_STYLE_CODEX"}}}

// 思考完成
{"interactionUpdate": {"thinkingCompleted": {"thinkingDurationMs": 160}}}
```

### Step 9: 文本流 (关键!)

```json
{"interactionUpdate": {"textDelta": {"text": "\nHello World"}}}
{"interactionUpdate": {"tokenDelta": {"tokens": 3}}}
{"interactionUpdate": {"stepCompleted": {"stepId": "2", "stepDurationMs": "628"}}}
```

### Step 10: 回合结束

```json
{
  "interactionUpdate": {
    "turnEnded": {
      "inputTokens": "6759",
      "outputTokens": "61",
      "cacheReadTokens": "5120",
      "cacheWriteTokens": "1639"
    }
  }
}
```

### 处理工具调用 (Exec 消息)

服务器可能发送以下 exec 请求：

| exec类型 | 说明 | 回复类型 |
|----------|------|----------|
| `requestContextArgs` | 请求上下文 | `requestContextResult` |
| `readArgs` | 读取文件 | `readResult` |
| `lsArgs` | 列出目录 | `lsResult` |
| `shellArgs` | 执行命令 | `shellResult` |
| `grepArgs` | 搜索内容 | `grepResult` |
| `writeArgs` | 写入文件 | `writeResult` |
| `deleteArgs` | 删除文件 | `deleteResult` |
| `diagnosticsArgs` | 诊断信息 | `diagnosticsResult` |
| `recordScreenArgs` | 录屏 | `recordScreenResult` |

**Headless 模式回复示例:**

```javascript
// readArgs → fileNotFound
{ execClientMessage: { id, execId, readResult: { fileNotFound: {} } } }

// shellArgs → rejected
{ execClientMessage: { id, execId, shellResult: { rejected: { reason: 'Not available' } } } }

// lsArgs → error
{ execClientMessage: { id, execId, lsResult: { error: { path: '', error: 'Not available' } } } }
```

---

## 6. Protobuf 类型定义

### agent.v1.AgentClientMessage (客户端→服务器)

```protobuf
message AgentClientMessage {
  oneof message {
    AgentRunRequest run_request = 1;           // 发起新请求
    ExecClientMessage exec_client_message = 2; // exec 回复
    ExecClientControlMessage exec_client_control_message = 5;
    KVClientMessage kv_client_message = 3;
    ConversationAction conversation_action = 4; // 对话操作
    InteractionResponse interaction_response = 6;
    ClientHeartbeat client_heartbeat = 7;       // 心跳
    PrewarmRequest prewarm_request = 8;
  }
}
```

### agent.v1.AgentRunRequest

```protobuf
message AgentRunRequest {
  ConversationStateStructure conversation_state = 1; // 必填(可以为空)
  ConversationAction action = 2;                      // 操作类型
  ModelDetails model_details = 3;                     // 模型详情
  RequestedModel requested_model = 9;                 // 请求的模型
  McpTools mcp_tools = 4;                             // MCP 工具
  string conversation_id = 5;                         // 对话 ID
  McpFileSystemOptions mcp_file_system_options = 6;
  SkillOptions skill_options = 7;
  string custom_system_prompt = 8;
  bool suggest_next_prompt = ?;
  string subagent_type_name = ?;
}
```

### agent.v1.ConversationAction

```protobuf
message ConversationAction {
  oneof action {
    UserMessageAction user_message_action = 1;  // 用户消息
    ResumeAction resume_action = 2;              // 恢复
    CancelAction cancel_action = 3;              // 取消
    SummarizeAction summarize_action = 4;        // 摘要
    ShellCommandAction shell_command_action = 5; // shell 命令
    StartPlanAction start_plan_action = 6;       // 开始计划
    ExecutePlanAction execute_plan_action = 7;   // 执行计划
    AsyncAskQuestionCompletionAction async_ask = 8;
    CancelSubagentAction cancel_subagent = 10;
  }
  string triggering_auth_id = ?;
}
```

### agent.v1.UserMessageAction

```protobuf
message UserMessageAction {
  UserMessage user_message = 1;           // 用户消息
  RequestContext request_context = 2;     // 请求上下文
  bool send_to_interaction_listener = 3;
  repeated UserMessage prepend_user_messages = 4;
}
```

### agent.v1.UserMessage

```protobuf
message UserMessage {
  string text = 1;                             // 消息文本
  string message_id = 2;                       // 消息 ID
  SelectedContext selected_context = 3;        // 选中的上下文
  int32 mode = 4;                              // 模式 (0=default)
  bool is_simulated_msg = ?;
  string best_of_n_group_id = ?;
  RichText rich_text = ?;
  string simulated_msg_reason = ?;
  bytes conversation_state_blob_id = ?;
  string subagent_system_reminder = ?;
}
```

### agent.v1.ModelDetails

```protobuf
message ModelDetails {
  string model_id = 1;              // 如 "composer-2"
  string display_model_id = 3;
  string display_name = 4;          // 如 "Composer 2"
  string display_name_short = 5;    // 如 "Composer 2"
  repeated string aliases = 6;
  ThinkingDetails thinking_details = ?;
  bool max_mode = ?;
  oneof credentials { ... }
}
```

### agent.v1.RequestedModel

```protobuf
message RequestedModel {
  string model_id = 1;      // 如 "composer-2"
  bool max_mode = 2;
  repeated Parameter parameters = 3;
  oneof credentials {
    ApiKeyCredentials api_key_credentials = 4;
    AzureCredentials azure_credentials = 5;
  }
}
```

### agent.v1.ConversationStateStructure

```protobuf
message ConversationStateStructure {
  repeated bytes turns_old = 2;
  repeated bytes root_prompt_messages_json = ?;
  repeated Turn turns = ?;
  repeated Todo todos = ?;
  repeated PendingToolCall pending_tool_calls = ?;
  TokenDetails token_details = ?;
  Summary summary = ?;
  Plan plan = ?;
  repeated string previous_workspace_uris = ?;
  Mode mode = ?;
  map<string, FileState> file_states = ?;
  map<string, FileStateV2> file_states_v2 = ?;
  repeated SummaryArchive summary_archives = ?;
  repeated TurnTiming turn_timings = ?;
  map<string, SubagentState> subagent_states = ?;
  int32 self_summary_count = ?;
  repeated string read_paths = ?;
}
```

### agent.v1.RequestContext

```protobuf
message RequestContext {
  repeated Rule rules = 2;
  Environment env = 4;
  repeated RepositoryInfo repository_info = 6;
  repeated Tool tools = 7;
  string conversation_notes_listing = 8;
  string shared_notes_listing = 9;
  repeated GitRepo git_repos = 11;
  repeated ProjectLayout project_layouts = 13;
  repeated McpInstruction mcp_instructions = ?;
  map<string, string> file_contents = ?;
  repeated CustomSubagent custom_subagents = ?;
  repeated AgentSkill agent_skills = ?;
  repeated PrecomputedHumanChanges precomputed_human_changes = ?;
}
```

### agent.v1.RequestContextResult

```protobuf
message RequestContextResult {
  oneof result {
    RequestContextSuccess success = 1;  // 成功
    RequestContextError error = 2;       // 错误
    RequestContextRejected rejected = 3; // 拒绝
  }
}

message RequestContextSuccess {
  RequestContext request_context = 1;
}
```

### agent.v1.ExecServerMessage

```protobuf
message ExecServerMessage {
  uint32 id = 1;           // 消息 ID，回复时需匹配
  string exec_id = 15;
  oneof message {
    ShellArgs shell_args = 2;
    WriteArgs write_args = 3;
    DeleteArgs delete_args = 4;
    GrepArgs grep_args = 5;
    ReadArgs read_args = 7;
    LsArgs ls_args = 8;
    DiagnosticsArgs diagnostics_args = 9;
    RequestContextArgs request_context_args = 10;
    RecordScreenArgs record_screen_args = ?;
  }
}
```

### agent.v1.ExecClientMessage

```protobuf
message ExecClientMessage {
  uint32 id = 1;           // 匹配 ExecServerMessage 的 id
  string exec_id = 15;
  oneof message {
    ShellResult shell_result = 2;
    WriteResult write_result = 3;
    DeleteResult delete_result = 4;
    GrepResult grep_result = 5;
    ReadResult read_result = 7;
    LsResult ls_result = 8;
    DiagnosticsResult diagnostics_result = 9;
    RequestContextResult request_context_result = 10;
    McpResult mcp_result = 11;
    ShellStream shell_stream = 14;
    BackgroundShellSpawnResult background_shell_spawn_result = 16;
  }
}
```

### aiserver.v1.StreamUnifiedChatRequest (旧格式, 参考)

```protobuf
message StreamUnifiedChatRequest {
  repeated ConversationMessage conversation = 1;
  bool allow_long_file_scan = 2;
  ExplicitContext explicit_context = 3;
  bool can_handle_filenames_after_language_ids = 4;
  ModelDetails model_details = 5;            // { model_name: "composer-2" }
  LinterErrors linter_errors = 6;
  repeated string documentation_identifiers = 7;
  string use_web = 8;
  repeated ExternalLink external_links = 9;
  ConversationMessage project_context = 10;
  CurrentFileInfo current_file = 15;
  bool is_chat = 22;
  string conversation_id = 23;
  bool is_agentic = 27;
  repeated ToolType supported_tools = 29;
  bool enable_yolo_mode = 31;
  string yolo_prompt = 32;
  bool use_unified_chat_prompt = 33;
  repeated McpTool mcp_tools = 34;
  bool is_headless = 45;
  bool is_background_composer = 68;
  repeated string workspace_folders = ?;
  // ... 更多字段 (总计 70+ 字段)
}
```

### 枚举定义

```protobuf
// 消息类型 (ul 枚举)
enum MessageType {
  MESSAGE_TYPE_UNSPECIFIED = 0;
  MESSAGE_TYPE_HUMAN = 1;
  MESSAGE_TYPE_AI = 2;
}
```

---

## 7. 可用模型列表

通过 `GetUsableModels` API 获取（2026-03-20）：

### Composer 系列
| Model ID | Display Name |
|----------|-------------|
| `default` | Auto（自动选择） |
| `composer-2` | Composer 2 |
| `composer-2-fast` | Composer 2 Fast |
| `composer-1.5` | Composer 1.5 |

### GPT 系列
| Model ID | Display Name |
|----------|-------------|
| `gpt-5.4-low` | GPT-5.4 Low |
| `gpt-5.4-medium` | GPT-5.4 |
| `gpt-5.4-medium-fast` | GPT-5.4 Fast |
| `gpt-5.4-high` | GPT-5.4 High |
| `gpt-5.4-high-fast` | GPT-5.4 High Fast |
| `gpt-5.4-xhigh` | GPT-5.4 Extra High |
| `gpt-5.4-xhigh-fast` | GPT-5.4 Extra High Fast |
| `gpt-5.3-codex-spark-preview` | GPT-5.3 Codex Spark |
| `gpt-5.3-codex-low` | GPT-5.3 Codex Low |
| `gpt-5.3-codex-low-fast` | GPT-5.3 Codex Low Fast |
| `gpt-5.3-codex` | GPT-5.3 Codex |
| `gpt-5.3-codex-fast` | GPT-5.3 Codex Fast |
| `gpt-5.3-codex-high` | GPT-5.3 Codex High |
| `gpt-5.3-codex-high-fast` | GPT-5.3 Codex High Fast |
| `gpt-5.3-codex-xhigh` | GPT-5.3 Codex Extra High |
| `gpt-5.3-codex-xhigh-fast` | GPT-5.3 Codex Extra High Fast |
| `gpt-5.2` | GPT-5.2 |
| `gpt-5.2-high` | GPT-5.2 High |
| `gpt-5.2-codex-low` | GPT-5.2 Codex Low |
| `gpt-5.2-codex-low-fast` | GPT-5.2 Codex Low Fast |
| `gpt-5.2-codex` | GPT-5.2 Codex |
| `gpt-5.2-codex-fast` | GPT-5.2 Codex Fast |
| `gpt-5.2-codex-high` | GPT-5.2 Codex High |
| `gpt-5.2-codex-high-fast` | GPT-5.2 Codex High Fast |
| `gpt-5.2-codex-xhigh` | GPT-5.2 Codex Extra High |
| `gpt-5.2-codex-xhigh-fast` | GPT-5.2 Codex Extra High Fast |
| `gpt-5.1-low` | GPT-5.1 Low |
| `gpt-5.1` | GPT-5.1 |
| `gpt-5.1-high` | GPT-5.1 High |
| `gpt-5.1-codex-mini` | GPT-5.1 Codex Mini |
| `gpt-5.1-codex-max-high` | GPT-5.1 Codex Max High |

### Claude 系列
| Model ID | Display Name |
|----------|-------------|
| `claude-4.6-sonnet-medium` | Claude 4.6 Sonnet |
| `claude-4.6-sonnet-medium-thinking` | Claude 4.6 Sonnet (Thinking) |
| `claude-4.6-opus-high` | Claude 4.6 Opus |
| `claude-4.6-opus-high-thinking` | Claude 4.6 Opus (Thinking) |
| `claude-4.5-opus-high` | Claude 4.5 Opus |
| `claude-4.5-opus-high-thinking` | Claude 4.5 Opus (Thinking) |
| `claude-4.5-sonnet` | Claude 4.5 Sonnet |
| `claude-4.5-sonnet-thinking` | Claude 4.5 Sonnet (Thinking) |

### Gemini 系列
| Model ID | Display Name |
|----------|-------------|
| `gemini-3.1-pro` | Gemini 3.1 Pro |
| `gemini-3-pro` | Gemini 3 Pro |
| `gemini-3-flash` | Gemini 3 Flash |

### 其他
| Model ID | Display Name |
|----------|-------------|
| `kimi-k2.5` | Kimi K2.5 |

> ⚠️ **注意**: 模型列表会随时变化, 请通过 `GetUsableModels` API 动态获取。

---

## 8. 凭证提取

### Token 存储位置

```
Windows: %APPDATA%\Cursor\User\globalStorage\state.vscdb
macOS:   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
Linux:   ~/.config/Cursor/User/globalStorage/state.vscdb
```

### 数据库格式

SQLite 数据库，表 `ItemTable`，键值对存储。

### 所需的键

| Key | 说明 |
|-----|------|
| `cursorAuth/accessToken` | 认证令牌 (必须) |
| `telemetry.machineId` | 机器 ID (用于 checksum) |
| `telemetry.macMachineId` | Mac 机器 ID (用于 checksum) |

### 提取代码

```javascript
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

function extractCredentials() {
  const dbPath = path.join(
    os.homedir(), 
    'AppData', 'Roaming', 'Cursor', 'User', 
    'globalStorage', 'state.vscdb'
  );
  const db = new Database(dbPath, { readonly: true });
  const get = key => {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    return row ? row.value : null;
  };
  const creds = {
    accessToken: get('cursorAuth/accessToken'),
    machineId: get('telemetry.machineId'),
    macMachineId: get('telemetry.macMachineId'),
  };
  db.close();
  return creds;
}
```

---

## 9. Checksum 生成算法

`x-cursor-checksum` 使用时间混淆 + 机器 ID 组合。

```javascript
function generateChecksum(machineId, macMachineId) {
  let key = 165;
  const timestamp = Math.floor(Date.now() / 1e6);
  const bytes = new Uint8Array([
    (timestamp >> 40) & 255,
    (timestamp >> 32) & 255,
    (timestamp >> 24) & 255,
    (timestamp >> 16) & 255,
    (timestamp >> 8) & 255,
    timestamp & 255,
  ]);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = ((bytes[i] ^ key) + (i % 256)) & 0xFF;
    key = bytes[i];
  }
  const prefix = Buffer.from(bytes).toString('base64');
  return macMachineId
    ? `${prefix}${machineId}/${macMachineId}`
    : `${prefix}${machineId}`;
}
```

---

## 10. 完整工作示例

### 最小可运行示例 (Node.js)

```javascript
const http2 = require('http2');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

// ── 凭证提取 ──
function extractCredentials() {
  const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 
                           'User', 'globalStorage', 'state.vscdb');
  const db = new Database(dbPath, { readonly: true });
  const g = k => {
    const r = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(k);
    return r ? r.value : null;
  };
  const c = {
    accessToken: g('cursorAuth/accessToken'),
    machineId: g('telemetry.machineId'),
    macMachineId: g('telemetry.macMachineId'),
  };
  db.close();
  return c;
}

// ── Checksum 生成 ──
function generateChecksum(mid, mmid) {
  let k = 165;
  const t = Math.floor(Date.now() / 1e6);
  const b = new Uint8Array([
    (t >> 40) & 255, (t >> 32) & 255, (t >> 24) & 255,
    (t >> 16) & 255, (t >> 8) & 255, t & 255
  ]);
  for (let i = 0; i < b.length; i++) {
    b[i] = ((b[i] ^ k) + (i % 256)) & 0xFF;
    k = b[i];
  }
  const prefix = Buffer.from(b).toString('base64');
  return mmid ? `${prefix}${mid}/${mmid}` : `${prefix}${mid}`;
}

// ── Envelope 帧写入 ──
function writeFrame(req, obj) {
  const jsonBuf = Buffer.from(JSON.stringify(obj), 'utf8');
  const frame = Buffer.alloc(5 + jsonBuf.length);
  frame[0] = 0;
  frame.writeUInt32BE(jsonBuf.length, 1);
  jsonBuf.copy(frame, 5);
  req.write(frame);
}

// ── 主函数 ──
async function chat(prompt, modelId = 'composer-2') {
  const creds = extractCredentials();
  const conversationId = uuidv4();
  const requestId = uuidv4();

  return new Promise((resolve, reject) => {
    const client = http2.connect('https://api2.cursor.sh');
    const req = client.request({
      ':method': 'POST',
      ':path': '/agent.v1.AgentService/Run',
      'content-type': 'application/connect+json',
      'connect-protocol-version': '1',
      'authorization': `Bearer ${creds.accessToken}`,
      'x-cursor-checksum': generateChecksum(creds.machineId, creds.macMachineId),
      'x-cursor-client-version': '2.6.20',
      'x-cursor-timezone': 'Asia/Shanghai',
      'x-request-id': requestId,
    });

    req.setTimeout(120000);
    let fullText = '';
    let buffer = Buffer.alloc(0);
    let done = false;

    // 心跳定时器
    const heartbeat = setInterval(() => {
      try { writeFrame(req, { clientHeartbeat: {} }); } catch {}
    }, 5000);

    function finish() {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      try { req.end(); } catch {}
      setTimeout(() => {
        try { client.close(); } catch {}
        resolve(fullText);
      }, 200);
    }

    req.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      let offset = 0;
      while (offset + 5 <= buffer.length) {
        const len = buffer.readUInt32BE(offset + 1);
        if (offset + 5 + len > buffer.length) break;
        const s = buffer.slice(offset + 5, offset + 5 + len).toString('utf8');
        offset += 5 + len;
        try {
          const msg = JSON.parse(s);

          // 错误处理
          if (msg.error) {
            finish();
            reject(new Error(msg.error.message || msg.error.code));
            return;
          }

          // 处理 exec 请求
          if (msg.execServerMessage) {
            const { id, execId } = msg.execServerMessage;
            if (msg.execServerMessage.requestContextArgs) {
              writeFrame(req, {
                execClientMessage: {
                  id, execId,
                  requestContextResult: {
                    success: {
                      requestContext: {
                        env: { operatingSystem: 'windows', defaultShell: 'powershell' }
                      }
                    }
                  }
                }
              });
            } else if (msg.execServerMessage.readArgs) {
              writeFrame(req, {
                execClientMessage: { id, execId, readResult: { fileNotFound: {} } }
              });
            } else if (msg.execServerMessage.lsArgs) {
              writeFrame(req, {
                execClientMessage: { id, execId, lsResult: { error: { path: '', error: 'N/A' } } }
              });
            } else if (msg.execServerMessage.shellArgs) {
              writeFrame(req, {
                execClientMessage: { id, execId, shellResult: { rejected: { reason: 'N/A' } } }
              });
            }
          }

          // 文本流
          if (msg.interactionUpdate?.textDelta) {
            const t = msg.interactionUpdate.textDelta;
            const text = typeof t === 'string' ? t : (t.text || t.delta || '');
            fullText += text;
          }

          // 结束
          if (msg.interactionUpdate?.turnEnded) {
            finish();
          }

        } catch {}
      }
      buffer = buffer.slice(offset);
    });

    req.on('end', finish);
    req.on('error', e => { finish(); reject(e); });
    req.on('timeout', () => { finish(); reject(new Error('timeout')); });

    // 发送请求
    writeFrame(req, {
      runRequest: {
        conversationState: {},
        action: {
          userMessageAction: {
            userMessage: { text: prompt }
          }
        },
        modelDetails: {
          modelId,
          displayName: modelId,
          displayNameShort: modelId,
        },
        requestedModel: { modelId },
        conversationId,
      }
    });
  });
}

// ── 使用示例 ──
async function main() {
  const reply = await chat('Hello, what is 2+2?', 'composer-2');
  console.log('Reply:', reply);
}

main().catch(console.error);
```

### 获取可用模型

```javascript
async function getModels(creds) {
  return new Promise((resolve) => {
    const client = http2.connect('https://api2.cursor.sh');
    const req = client.request({
      ':method': 'POST',
      ':path': '/agent.v1.AgentService/GetUsableModels',
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      'authorization': `Bearer ${creds.accessToken}`,
      'x-cursor-checksum': generateChecksum(creds.machineId, creds.macMachineId),
      'x-cursor-client-version': '2.6.20',
      'x-request-id': uuidv4(),
    });
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => {
      client.close();
      resolve(JSON.parse(body));
    });
    req.write(JSON.stringify({}));
    req.end();
  });
}
```

---

## 11. 已知问题与注意事项

### ⚠️ 重要限制

1. **BiDi 流不能提前关闭**: 发送 `runRequest` 后不能立即调用 `req.end()`，必须保持流开放直到 `turnEnded`
2. **必须回复 requestContextArgs**: 服务器发送的 `execServerMessage.requestContextArgs` 必须响应，否则会报 "Failed to get request context"
3. **心跳必须持续发送**: 建议每 5 秒发一次 `clientHeartbeat`
4. **模型名必须精确**: 使用不存在的模型名会返回 "Model name is not valid" 错误
5. **版本号要匹配**: `x-cursor-client-version` 版本太低会被拒绝

### 🔒 加密相关

- `x-idempotent-encryption-key`: 用于 Idempotent SSE/Poll 端点，由 AES-GCM 256位密钥导出
- `mcpEncryptionKey`: MCP 加密密钥，存储在 `_secretStorageService` 中
- 密钥通过 `crypto.subtle.generateKey('AES-GCM', 256)` 生成，`exportKey('jwk')` 导出

### 🌐 网络相关

- 目标域名: `api2.cursor.sh`
- 协议: HTTP/2 (必须)
- 端口: 443 (TLS)
- 可能需要代理/VPN 才能稳定连接

### 📝 KV Blob 数据

AI 回复的完整记录（含思考过程）存储在 KV setBlobArgs 中：
- blob 数据是 base64 编码的 JSON 或 protobuf
- 包含 system/user/assistant 角色的完整消息
- assistant 消息中包含 `<think>...</think>` 思考过程

---

## 附录: 变量名映射表

逆向分析中的 minified 变量名与对应的 protobuf 类型：

| 变量名 | protobuf 类型 |
|--------|--------------|
| `VNe` | `agent.v1.AgentClientMessage` |
| `jte` | `agent.v1.AgentServerMessage` |
| `yKl` | `agent.v1.AgentRunRequest` |
| `rye` | `agent.v1.ConversationAction` |
| `qha` | `agent.v1.UserMessageAction` |
| `m$e` | `agent.v1.UserMessage` |
| `jCt` | `agent.v1.RequestContext` |
| `rEe` | `agent.v1.ConversationStateStructure` |
| `Qfi` | `agent.v1.ModelDetails` |
| `Kdn` | `agent.v1.RequestedModel` |
| `sKl` | `agent.v1.RequestContextResult` |
| `oKl` | `agent.v1.RequestContextSuccess` |
| `g$e` | `agent.v1.ExecClientMessage` |
| `zou` | `agent.v1.ClientHeartbeat` |
| `OFc` | `aiserver.v1.StreamUnifiedChatRequestWithTools` |
| `ORe` | `aiserver.v1.StreamUnifiedChatRequest` |
| `G9e` | `aiserver.v1.StreamUnifiedChatResponseWithTools` |
| `C8n` | `aiserver.v1.StreamUnifiedChatResponse` |
| `Qw` | `aiserver.v1.ConversationMessage` |
| `Yf` | `aiserver.v1.ModelDetails` |
| `_S` | `aiserver.v1.CurrentFileInfo` |
| `Eye` | `aiserver.v1.BidiRequestId` |
| `X$e` | `aiserver.v1.BidiPollRequest` |
| `eqe` | `aiserver.v1.BidiPollResponse` |
| `ul` | `aiserver.v1.MessageType` (枚举) |
| `fLh` | `aiserver.v1.StreamUnifiedChatRequestWithToolsIdempotent` |
| `rRu` | `agent.v1.AgentService` (服务定义) |
| `WAi` | `aiserver.v1.ChatService` (服务定义) |
| `rau` | Agent Connect Client (运行时类) |

---

> **免责声明**: 本文档仅用于学习研究目的。使用 API 时请遵守 Cursor 的服务条款。
