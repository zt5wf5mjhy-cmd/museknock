export type BatchResult = 'accepted' | 'limited' | 'missingDevice' | 'noDestination' | 'invalidBreaker' | 'credentialStorageUnavailable'
export type Delivery = { id: string; source: string; type: string; text: string }
export type Claim = Delivery & { attempt: string; sessionId: string; vmId: string }
export type Outcome = 'sent' | 'unknown' | 'not_sent' | 'side_chat_missing'
