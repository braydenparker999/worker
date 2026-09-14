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

/**
 * Never let a legacy bridge reconnect evict an already-open newer protocol.
 * Equal or newer protocols may replace the socket to recover normal app or
 * network reconnects.
 */
export function shouldAcceptPhoneSocket(current, incomingProtocol) {
  if (!current || current.readyState !== OPEN) return true;
  const currentProtocol = Number(socketMetadata(current).protocol || 1);
  const candidateProtocol = Number(incomingProtocol || 1);
  return Number.isFinite(candidateProtocol) && candidateProtocol >= currentProtocol;
}
