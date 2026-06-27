let lastSessionId = null;

export function setSessionId(id) {
  lastSessionId = id;
}

export function getSessionId() {
  return lastSessionId;
}
