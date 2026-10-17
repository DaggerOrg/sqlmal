// Formatting for numbers, versions and dates as the UI shows them.

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** `512 B`, `2.0 KB`, `300 MB`. */
export function formatByteSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  let size = sizeBytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${BYTE_UNITS[unitIndex] ?? ''}`;
}

/** `999`, `1.5k`, `25k`, `2.4M`. */
export function formatCompactCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

/** Pads sequential versions (`0007`) but leaves timestamp versions alone. */
export function formatVersion(version: number): string {
  return version >= 100000 ? String(version) : String(version).padStart(4, '0');
}

/** A local date and time such as `10 Oct 2026, 16:33`. Empty for a missing timestamp. */
export function formatTimestamp(isoTimestamp?: string): string {
  if (!isoTimestamp) return '';
  return new Date(isoTimestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `1 table`, `3 tables`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** `create_users` becomes `create users`. */
export function humanizeMigrationName(migrationName: string): string {
  return migrationName.replace(/_/g, ' ');
}

export function capitalizeFirstLetter(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A release version gets a `v` prefix; a build label such as `dev` stays as it is. */
export function formatServerVersion(serverVersion: string): string {
  return /^\d/.test(serverVersion) ? `v${serverVersion}` : serverVersion;
}
