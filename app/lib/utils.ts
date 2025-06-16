import { WORK_DIR } from '~/utils/constants';
import semver from 'semver';
import type { Cache } from '@cloudflare/workers-types';

interface CloudflareCacheStorage extends CacheStorage {
  default: Cache;
}

function getPackageContent(files: any): string {
  const packageFile = files[`${WORK_DIR}/package.json`];

  return packageFile?.type === 'file' ? packageFile.content : '';
}

export async function resolvePackageVersion(packageName: string, files: any): Promise<string> {
  try {
    const packageContent = getPackageContent(files);
    const packageJson = JSON.parse(packageContent);
    const version = packageJson.dependencies?.[packageName];

    if (version) {
      return await getActualVersion(packageName, version);
    }

    return await getLatestVersion(packageName);
  } catch {
    throw new Error(`Failed to get version from package ${packageName}`);
  }
}

async function getActualVersion(packageName: string, versionRange: string): Promise<string> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}`);
    const packageInfo = (await res.json()) as { versions: Record<string, any> };
    const versions = Object.keys(packageInfo.versions);

    const actualVersion = semver.maxSatisfying(versions, versionRange);

    return actualVersion || versionRange;
  } catch {
    throw new Error(`Failed to resolve version for ${packageName}@${versionRange}`);
  }
}

async function getLatestVersion(packageName: string): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${packageName}`);

  if (!res.ok) {
    throw new Error(`Failed to fetch package metadata: ${res.status}`);
  }

  const metadata: any = await res.json();
  const latestVersion = metadata['dist-tags']?.latest;

  if (!latestVersion) {
    throw new Error('Latest version not found');
  }

  return latestVersion;
}

export async function fetchWithCache(url: string, cacheNamespace?: Cache): Promise<Response> {
  const isCacheAvailable = cacheNamespace || (typeof caches !== 'undefined' && caches);
  const cache = cacheNamespace ?? (isCacheAvailable ? (caches as CloudflareCacheStorage).default : undefined);

  try {
    if (cache) {
      const cacheKey = new Request(url, { method: 'GET' });
      const cachedResponse = await cache.match(cacheKey as any);

      if (cachedResponse) {
        return cachedResponse as unknown as Response;
      }

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }

      const responseClone = response.clone(); // clone before reading body
      await cache.put(cacheKey as any, responseClone as any);

      return response;
    } else {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }

      return response;
    }
  } catch (error) {
    throw new Error(`Failed to fetch text from ${url}: ${error}`);
  }
}

export function extractMarkdownFileNamesFromUnpkgHtml(html: string): string[] {
  const linkRegex = /<a[^>]*href="[^"]*\.md"[^>]*>([^<]*\.md)<\/a>/gi;
  const fileNames: string[] = [];

  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const fileName = match[1].trim();

    if (fileName && fileName.endsWith('.md')) {
      fileNames.push(fileName);
    }
  }

  return fileNames;
}
