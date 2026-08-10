const RELEASES = Object.freeze({
  wgcf: Object.freeze({
    version: '2.2.32',
    assets: Object.freeze({
      x64: Object.freeze({
        name: 'wgcf_2.2.32_linux_amd64',
        size: 12751010,
        sha256: '2ff97f2201972ce582a424455d50a3719a380eef0cd1f3144f7779348e122a2c',
      }),
      arm64: Object.freeze({
        name: 'wgcf_2.2.32_linux_arm64',
        size: 11862178,
        sha256: '21fe21d9f61db9b381d71200f6f59c7949e0bb455446edcb33dda6ad6a8fcf8f',
      }),
    }),
    url(asset) {
      return `https://github.com/ViRb3/wgcf/releases/download/v2.2.32/${asset.name}`;
    },
    archive: false,
    binaryName: 'wgcf',
  }),
  wireproxy: Object.freeze({
    version: '1.1.3',
    assets: Object.freeze({
      x64: Object.freeze({
        name: 'wireproxy_linux_amd64.tar.gz',
        size: 4123755,
        sha256: 'e88c1d090740373fc606c1bafd81d9a5eadc642cce5667616e20e9d7a444f51c',
      }),
      arm64: Object.freeze({
        name: 'wireproxy_linux_arm64.tar.gz',
        size: 3779562,
        sha256: '370e00bd2167960d1ecd1c3c1439715bbaa94a0a110a2040468670c9af6021b6',
      }),
    }),
    url(asset) {
      return `https://github.com/windtf/wireproxy/releases/download/v1.1.3/${asset.name}`;
    },
    archive: true,
    binaryName: 'wireproxy',
  }),
});

function resolveRelease(component, arch = process.arch) {
  const release = RELEASES[component];
  const asset = release && release.assets[arch];
  if (!release || !asset) {
    const error = new Error(`Unsupported WARP component or architecture: ${component}/${arch}`);
    error.code = 'unsupported_arch';
    throw error;
  }
  return {
    component,
    version: release.version,
    asset: asset.name,
    size: asset.size,
    sha256: asset.sha256,
    url: release.url(asset),
    archive: release.archive,
    binaryName: release.binaryName,
  };
}

module.exports = { RELEASES, resolveRelease };
