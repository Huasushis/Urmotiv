import { isIpAddressAllowedByCidrs, normalizeIpAddress } from "@urmotiv/contracts";
import type { FastifyRequest } from "fastify";

const maximumForwardedAddresses = 64;

/**
 * Resolve the address that a later authentication layer may use for source
 * restrictions. With no explicitly trusted proxy, forwarded headers are
 * ignored even if a caller supplies them.
 */
export function resolveClientAddress(
  request: FastifyRequest,
  trustedProxyCidrs: readonly string[],
): string | undefined {
  const remoteAddress = request.raw.socket.remoteAddress;
  const socketAddress =
    typeof remoteAddress === "string" ? normalizeIpAddress(remoteAddress) : undefined;
  if (
    socketAddress === undefined ||
    trustedProxyCidrs.length === 0 ||
    !isIpAddressAllowedByCidrs(socketAddress, trustedProxyCidrs)
  ) {
    return socketAddress;
  }

  const forwardedHeader = request.headers["x-forwarded-for"];
  if (forwardedHeader === undefined) return socketAddress;
  const entries = (
    Array.isArray(forwardedHeader) ? forwardedHeader.join(",") : forwardedHeader
  ).split(",");
  if (entries.length > maximumForwardedAddresses) return undefined;

  let currentAddress = socketAddress;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (!isIpAddressAllowedByCidrs(currentAddress, trustedProxyCidrs)) {
      return currentAddress;
    }
    const entry = entries[index];
    if (entry === undefined) return undefined;
    const forwardedAddress = normalizeIpAddress(entry.trim());
    if (forwardedAddress === undefined) return undefined;
    currentAddress = forwardedAddress;
  }
  return currentAddress;
}
