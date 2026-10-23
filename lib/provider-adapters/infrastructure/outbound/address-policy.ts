import { BlockList, isIP } from "node:net";

// F4 (docs/architecture/F4-GENERIC-OIDC-CONNECTIONS-DESIGN.md, section 3): an identity provider is reached on a public
// address only. Refused: loopback, private and shared ranges, link-local (the cloud metadata service included),
// multicast, broadcast, reserved, benchmarking and documentation ranges, and every IPv6 address outside global unicast
// (ULA, link-local, multicast, IPv4-mapped and NAT64 included), plus the special blocks inside global unicast.
const refused = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) refused.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) refused.addSubnet(network, prefix, "ipv6");
const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");

/** True only for an address an identity provider may be reached on. Anything unparsable is refused. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !refused.check(address, "ipv4");
  if (family === 6) return globalUnicast.check(address, "ipv6") && !refused.check(address, "ipv6");
  return false;
}
