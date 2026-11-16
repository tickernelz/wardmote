export const COMPANY_PACKAGE_EXTENSION_FILE = ".wardmote.yaml";
export const COMPANY_PACKAGE_EXTENSION_SCHEMA = "wardmote/v1";

const CURRENT_EXTENSION_NAMES = [".wardmote.yaml", ".wardmote.yml"];

function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

export function isCompanyPackageExtensionFile(filePath: string): boolean {
  return CURRENT_EXTENSION_NAMES.includes(baseName(filePath));
}

export function findCompanyPackageExtensionPath(paths: Iterable<string>): string | null {
  const all = Array.from(paths);
  for (const name of CURRENT_EXTENSION_NAMES) {
    if (all.includes(name)) return name;
  }
  return all.find(isCompanyPackageExtensionFile) ?? null;
}
