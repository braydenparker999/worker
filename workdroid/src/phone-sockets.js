const OPEN = 1;

export function socketMetadata(socket) {
  try {
    return socket.deserializeAttachment?.() || {};
  } catch {
    return {};
  }
}

function connectedAt(socket) {
  const value = Number(socketMetadata(socket).connectedAt || 0);
  return Number.isFinite(value) ? value : 0;
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
