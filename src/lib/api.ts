export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({ error: 'O servidor não retornou uma resposta válida.' }));
  if (!response.ok) throw new Error(payload.error || payload.message || `Falha na solicitação (${response.status}).`);
  return payload as T;
}
