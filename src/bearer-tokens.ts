export const localBearerTokens = ['HOOK_TOKEN', 'MCP_TOKEN', 'MCP_ADMIN_TOKEN'] as const
const bearerTokens = [...localBearerTokens, 'MCP_RECOVERY_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'] as const
type TokenName = (typeof bearerTokens)[number]

export function distinctBearerTokens(config: Partial<Record<TokenName, string>>) {
  const values = bearerTokens.map((name) => config[name]).filter(Boolean)
  return new Set(values).size === values.length
}
