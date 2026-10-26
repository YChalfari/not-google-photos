/** Bumped when a stable endpoint changes in a way old phone apps can't handle. */
export const API_VERSION = 1;

/** Browser session cookie (HttpOnly). Phones use device tokens instead. */
export const SESSION_COOKIE = 'ngp_session';

/** Token prefixes make leaked secrets easy to recognize and grep for. */
export const TOKEN_PREFIX = {
  session: 'ngps_',
  device: 'ngpd_',
  invite: 'ngpi_',
} as const;

/** Bonjour / DNS-SD service the Mac announces on the home network. */
export const BONJOUR_SERVICE_TYPE = '_ngp._tcp';

/** URI scheme encoded in device pairing QR codes. */
export const PAIRING_URI_SCHEME = 'notgooglephotos';

export const PAIRING_CODE_TTL_SECONDS = 10 * 60;
export const PAIRING_CODE_LENGTH = 10;
export const INVITE_DEFAULT_TTL_DAYS = 7;
export const INVITE_MAX_TTL_DAYS = 90;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/** InsightFace buffalo_l ArcFace embeddings. */
export const FACE_EMBEDDING_DIMENSIONS = 512;
/**
 * CLIP-family image/text embeddings. Must match the model the ML service ships and the
 * `asset_embeddings.embedding` column; changing it needs a migration that rebuilds the index.
 */
export const CLIP_EMBEDDING_DIMENSIONS = 768;

export const MAX_CHECK_BATCH = 5000;
export const MAX_VERIFY_BATCH = 1000;
export const MAX_SIGN_BATCH = 500;
export const MAX_PAGE_SIZE = 500;

export const MEDIA_VARIANTS = ['thumbnail', 'preview', 'original', 'playback'] as const;
export const ASSET_TYPES = ['image', 'video'] as const;
export const USER_ROLES = ['admin', 'member'] as const;
export const DEVICE_PLATFORMS = ['android', 'ios', 'web', 'other'] as const;
