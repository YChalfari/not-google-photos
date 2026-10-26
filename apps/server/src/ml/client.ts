export type MlStatus = 'ok' | 'unreachable' | 'disabled';

/** Talks to the Python ML service (`apps/ml`). Optional: the server runs fine without it. */
export class MlClient {
  private cached: { at: number; status: MlStatus } | undefined;

  constructor(readonly baseUrl: string | undefined) {}

  async status(): Promise<MlStatus> {
    if (!this.baseUrl) return 'disabled';
    if (this.cached && Date.now() - this.cached.at < 15_000) return this.cached.status;
    const status: MlStatus = await fetch(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(1500),
    }).then(
      (response) => (response.ok ? 'ok' : 'unreachable'),
      () => 'unreachable',
    );
    this.cached = { at: Date.now(), status };
    return status;
  }
}
