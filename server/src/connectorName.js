// The connector's display name from the configured airline. A name that already ends in "Airline(s)" (the family brand is "AirGuard Airlines")
// is not given a second "Airline"; an older single-word value keeps its existing "<airline> Airline Connector" form.
export function connectorName(airline) {
  const a = String(airline ?? '').trim();
  if (!a) return 'Airline Connector';
  return /\bairlines?$/i.test(a) ? `${a} Connector` : `${a} Airline Connector`;
}
