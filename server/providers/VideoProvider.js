import { StudioError } from '../core/errors.js';

/**
 * Provider-independent contract for image-to-video engines.
 *
 * Every provider (Runway, Veo direct, Kling, Luma, Seedance, …) extends this class
 * and returns the SAME normalised shapes so routes and the frontend never need to
 * know which vendor is behind a task.
 *
 * Normalised task status:
 * {
 *   taskId: string,
 *   provider: string,
 *   state: 'queued' | 'throttled' | 'running' | 'succeeded' | 'failed' | 'cancelled',
 *   progress: number | null,     // 0..1 exactly as reported by the provider, null if not reported
 *   outputs: string[],           // video URLs (only when succeeded)
 *   failure: string | null,      // provider's human-readable reason
 *   failureCode: string | null,  // provider's machine-readable code
 *   createdAt: string | null,
 *   credits: { estimated?: number, charged?: number } | null,
 *   raw: string                  // provider's raw status value
 * }
 */
export class VideoProvider {
  /** @returns {string} stable id, e.g. 'runway' */
  get id() {
    throw new Error('Provider must implement id');
  }

  /** @returns {boolean} true when the backend has the secret(s) it needs */
  isConfigured() {
    return false;
  }

  /**
   * Start a generation.
   * @param {object} job
   * @param {string} job.model          provider model id (validated against models.js)
   * @param {string} job.image          data URI or https URL of the first frame
   * @param {string} job.prompt         motion prompt
   * @param {string} [job.negativePrompt]
   * @param {number} job.duration       seconds
   * @param {string} job.ratio          provider ratio value, e.g. '1280:720'
   * @param {number} [job.seed]
   * @param {boolean} [job.audio]
   * @returns {Promise<{ taskId: string, estimatedCredits: number | null }>}
   */
  // eslint-disable-next-line no-unused-vars
  async generate(job) {
    throw new StudioError('NOT_IMPLEMENTED', `${this.id}: generate() not implemented`);
  }

  /** @returns {Promise<object>} normalised task status (see above) */
  // eslint-disable-next-line no-unused-vars
  async getStatus(taskId) {
    throw new StudioError('NOT_IMPLEMENTED', `${this.id}: getStatus() not implemented`);
  }

  /**
   * @returns {Promise<{ videoUrl: string, outputs: string[] }>} only for succeeded tasks
   */
  async getResult(taskId) {
    const status = await this.getStatus(taskId);
    if (status.state !== 'succeeded') {
      throw new StudioError('INVALID_REQUEST', `Task is ${status.state}, no result available yet.`);
    }
    if (!status.outputs?.length) {
      throw new StudioError('PROVIDER_ERROR', 'Provider reported success but returned no video output.');
    }
    return { videoUrl: status.outputs[0], outputs: status.outputs };
  }

  // eslint-disable-next-line no-unused-vars
  async cancel(taskId) {
    throw new StudioError('NOT_IMPLEMENTED', `${this.id}: cancel() not implemented`);
  }

  /** Optional: account info such as remaining credits. */
  async getAccountInfo() {
    return null;
  }
}
