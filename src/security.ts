export type CommandClassification = {
  kind: 'bind' | 'confirm' | 'cancel' | 'status' | 'task' | 'reminder' | 'send_file' | 'execute' | 'chat';
  requiresConfirmation: boolean;
};

export function isOwnerAuthorized(ownerUserId: string | undefined, fromUserId: string, text: string): boolean {
  if (!ownerUserId) return text.trim() === '绑定';
  return ownerUserId === fromUserId;
}

export function classifyUserText(text: string): CommandClassification {
  const trimmed = text.trim();
  if (trimmed === '绑定') return { kind: 'bind', requiresConfirmation: false };
  if (/^确认(?:\s*#?\d+)?$/u.test(trimmed)) return { kind: 'confirm', requiresConfirmation: false };
  if (/^取消(?:\s*#?\d+)?$/u.test(trimmed)) return { kind: 'cancel', requiresConfirmation: false };
  if (trimmed === '状态') return { kind: 'status', requiresConfirmation: false };
  if (/^任务\s*#?\d+$/u.test(trimmed)) return { kind: 'task', requiresConfirmation: false };
  if (/^提醒我\s+/u.test(trimmed)) return { kind: 'reminder', requiresConfirmation: true };
  if (/(发给我|发送文件|传给我|传输|send file)/iu.test(trimmed) && /(文件|pdf|docx?|xlsx?|pptx?|txt|md|zip|rar|7z)/iu.test(trimmed)) {
    return { kind: 'send_file', requiresConfirmation: true };
  }
  if (/^(执行|运行|删除|移动|修改|写入|exec\b|run\b)/iu.test(trimmed)) return { kind: 'execute', requiresConfirmation: true };
  return { kind: 'chat', requiresConfirmation: false };
}

export function parseActionId(text: string): number | undefined {
  const match = text.match(/#?(\d+)/u);
  return match ? Number(match[1]) : undefined;
}
