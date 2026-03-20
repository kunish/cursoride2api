// ═══════════════════════════════════════════════
//  CursorIDE2API v2 - 简化配置
// ═══════════════════════════════════════════════

const config = {
  cursor: {
    baseUrl: 'https://api2.cursor.sh',
    clientVersion: process.env.CURSOR_CLIENT_VERSION || '2.6.20',
    defaultModel: process.env.DEFAULT_MODEL || 'claude-4.5-sonnet',
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '120000'),
    heartbeatInterval: 5000,
  },

  // 模型映射 (OpenAI model → Cursor model)
  modelMapping: {
    'gpt-4': 'composer-2',
    'gpt-4o': 'composer-2',
    'gpt-4o-mini': 'composer-2-fast',
    'gpt-4-turbo': 'composer-2',
    'gpt-3.5-turbo': 'composer-1.5',
    'claude-3-opus': 'claude-4.6-opus-high',
    'claude-3-sonnet': 'claude-4.6-sonnet-medium',
    'claude-3.5-sonnet': 'claude-4.5-sonnet',
    'gemini-pro': 'gemini-3.1-pro',
    // 直通
    'composer-2': 'composer-2',
    'composer-2-fast': 'composer-2-fast',
    'composer-1.5': 'composer-1.5',
    'default': 'default',
  },
};

module.exports = config;
