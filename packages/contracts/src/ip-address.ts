type Ipv4Address = {
  readonly family: 4;
  readonly groups: Ipv4Groups;
};

type Ipv6Address = {
  readonly family: 6;
  readonly groups: readonly number[];
  readonly mappedIpv4?: readonly number[];
};

type IpAddress = Ipv4Address | Ipv6Address;
type Ipv4Groups = readonly [number, number, number, number];

function parseIpv4Address(value: string): Ipv4Groups | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const numeric = Number(part);
    if (numeric > 255) return undefined;
    octets.push(numeric);
  }
  const first = octets[0];
  const second = octets[1];
  const third = octets[2];
  const fourth = octets[3];
  return first === undefined || second === undefined || third === undefined || fourth === undefined
    ? undefined
    : [first, second, third, fourth];
}

function parseIpv6Groups(rawValue: string): number[] | undefined {
  if (!rawValue.includes(":")) return undefined;
  let value = rawValue.toLowerCase();
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    if (separator < 0) return undefined;
    const octets = parseIpv4Address(value.slice(separator + 1));
    if (octets === undefined) return undefined;
    const high = (octets[0] << 8) | octets[1];
    const low = (octets[2] << 8) | octets[3];
    value = `${value.slice(0, separator)}:${high.toString(16)}:${low.toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(value) || value.includes(":::")) return undefined;
  const compressed = value.indexOf("::");
  if (compressed !== value.lastIndexOf("::")) return undefined;
  const parseGroups = (part: string): number[] | undefined => {
    if (part.length === 0) return [];
    const groups = part.split(":");
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  if (compressed < 0) {
    const groups = parseGroups(value);
    return groups?.length === 8 ? groups : undefined;
  }
  const left = parseGroups(value.slice(0, compressed));
  const right = parseGroups(value.slice(compressed + 2));
  if (left === undefined || right === undefined || left.length + right.length >= 8) {
    return undefined;
  }
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function mappedIpv4(groups: readonly number[]): Ipv4Groups | undefined {
  if (
    groups.length !== 8 ||
    groups.slice(0, 5).some((group) => group !== 0) ||
    groups[5] !== 0xffff
  ) {
    return undefined;
  }
  const high = groups[6];
  const low = groups[7];
  return high === undefined || low === undefined
    ? undefined
    : [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function mappedIpv6(groups: Ipv4Groups): number[] {
  return [0, 0, 0, 0, 0, 0xffff, (groups[0] << 8) | groups[1], (groups[2] << 8) | groups[3]];
}

function parseIpAddress(value: string): IpAddress | undefined {
  const ipv4 = parseIpv4Address(value);
  if (ipv4 !== undefined) return { family: 4, groups: ipv4 };
  const ipv6 = parseIpv6Groups(value);
  if (ipv6 === undefined) return undefined;
  const embedded = mappedIpv4(ipv6);
  return {
    family: 6,
    groups: ipv6,
    ...(embedded === undefined ? {} : { mappedIpv4: embedded }),
  };
}

function canonicalIpv6Address(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length; ) {
    if (groups[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - start > bestLength && end - start >= 2) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const values = groups.map((group) => group.toString(16));
  if (bestStart < 0) return values.join(":");
  const before = values.slice(0, bestStart).join(":");
  const after = values.slice(bestStart + bestLength).join(":");
  return `${before}::${after}`;
}

function networkGroups(groups: readonly number[], prefix: number, groupBits: 8 | 16): number[] {
  let remaining = prefix;
  const maximum = 2 ** groupBits - 1;
  return groups.map((group) => {
    if (remaining >= groupBits) {
      remaining -= groupBits;
      return group;
    }
    if (remaining <= 0) return 0;
    const mask = maximum - (2 ** (groupBits - remaining) - 1);
    remaining = 0;
    return group & mask;
  });
}

function parsePrefix(value: string, maximum: number): number | undefined {
  if (!/^(0|[1-9]\d{0,2})$/.test(value)) return undefined;
  const prefix = Number(value);
  return prefix <= maximum ? prefix : undefined;
}

function splitCidr(value: string): { address: IpAddress; prefix: number } | undefined {
  const separator = value.lastIndexOf("/");
  if (separator <= 0 || separator !== value.indexOf("/")) return undefined;
  const address = parseIpAddress(value.slice(0, separator));
  if (address === undefined) return undefined;
  const prefix = parsePrefix(value.slice(separator + 1), address.family === 4 ? 32 : 128);
  return prefix === undefined ? undefined : { address, prefix };
}

export function normalizeIpAddress(value: string): string | undefined {
  const address = parseIpAddress(value);
  if (address === undefined) return undefined;
  if (address.family === 4) return address.groups.join(".");
  return address.mappedIpv4 === undefined
    ? canonicalIpv6Address(address.groups)
    : address.mappedIpv4.join(".");
}

export function normalizeIpCidr(value: string): string | undefined {
  const parsed = splitCidr(value);
  if (parsed === undefined) return undefined;
  if (parsed.address.family === 6 && parsed.address.mappedIpv4 !== undefined) {
    if (parsed.prefix < 96) return undefined;
    const ipv4Prefix = parsed.prefix - 96;
    return `${networkGroups(parsed.address.mappedIpv4, ipv4Prefix, 8).join(".")}/${ipv4Prefix}`;
  }
  const groupBits = parsed.address.family === 4 ? 8 : 16;
  const network = networkGroups(parsed.address.groups, parsed.prefix, groupBits);
  const address = parsed.address.family === 4 ? network.join(".") : canonicalIpv6Address(network);
  return `${address}/${parsed.prefix}`;
}

export function isIpAddressInCidr(addressValue: string, cidrValue: string): boolean {
  const address = parseIpAddress(addressValue);
  const cidr = splitCidr(cidrValue);
  if (address === undefined || cidr === undefined) return false;

  if (cidr.address.family === 4) {
    const candidate = address.family === 4 ? address.groups : address.mappedIpv4;
    if (candidate === undefined) return false;
    const network = networkGroups(cidr.address.groups, cidr.prefix, 8);
    return networkGroups(candidate, cidr.prefix, 8).every(
      (group, index) => group === network[index],
    );
  }

  const candidate = address.family === 6 ? address.groups : mappedIpv6(address.groups);
  const network = networkGroups(cidr.address.groups, cidr.prefix, 16);
  return networkGroups(candidate, cidr.prefix, 16).every(
    (group, index) => group === network[index],
  );
}

export function isIpAddressAllowedByCidrs(
  address: string | undefined,
  cidrs: readonly string[],
): boolean {
  if (cidrs.length === 0) return true;
  if (address === undefined) return false;
  return cidrs.some((cidr) => isIpAddressInCidr(address, cidr));
}
