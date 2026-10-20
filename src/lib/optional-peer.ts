/**
 * Optional peer packages: SDKs a connector needs that are not installed with
 * log10x-mcp, so a default `npx log10x-mcp` stays small enough to start
 * inside an MCP client's connect timeout. Loaded on first use.
 */

export class OptionalPeerMissingError extends Error {
  constructor(feature: string, packages: string[]) {
    super(
      `${feature} needs ${packages.join(' and ')}, optional packages not installed with log10x-mcp. ` +
        `Start the server with them: npx -y -p log10x-mcp ${packages.map((p) => `-p ${p}`).join(' ')} log10x-mcp`,
    );
    this.name = 'OptionalPeerMissingError';
  }
}

/** Import an optional peer, or throw OptionalPeerMissingError naming every package the feature needs. */
export async function importOptionalPeer<T>(specifier: string, feature: string, packages: string[]): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new OptionalPeerMissingError(feature, packages);
    }
    throw e;
  }
}
