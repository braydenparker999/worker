const OPEN = 1;

function connectedAt(socket) {
  try {
    const value = Number(socket.deserializeAttachment?.()?.connectedAt || 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Pick the newest socket that is actually open. Durable Objects may briefly
 * return a closing socket after a replacement connection has been accepted.
 */
export function selectPhoneSocket(sockets) {
  return [...sockets]
    .filter(socket => socket?.readyState === OPEN)
    .sort((left, right) => connectedAt(right) - connectedAt(left))[0] || null;
}
