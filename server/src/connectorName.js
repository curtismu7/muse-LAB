// The connector's display name from the configured airline. A name that already ends in "Airline(s)" (the family brand is "AirGuard Airlines")
// is not given a second "Airline"; an older single-word value keeps its existing "<airline> Airline Connector" form.
export function connectorName(airline) {
  const a = String(airline ?? '').trim();
  if (!a) return 'Airline Connector';
  return /\bairlines?$/i.test(a) ? `${a} Connector` : `${a} Airline Connector`;
}

// The MCP serverInfo.name: the lower-case slug of the airline plus "-airline-connector" (no second "airline" after the full brand).
// An older single-word value gives exactly the name it always did.
export function connectorServerName(airline) {
  const a = String(airline ?? '').trim();
  if (!a) return 'airline-connector';
  const slug = a.toLowerCase().replace(/ +/g, '-');
  return /\bairlines?$/i.test(a) ? `${slug}-connector` : `${slug}-airline-connector`;
}
