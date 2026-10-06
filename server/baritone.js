'use strict';

// Baritone (https://github.com/cabaletta/baritone, LGPL-3.0), the pathfinding
// bot, runs on the Fabric mod loader. Each Baritone release supports specific
// Minecraft versions; this table maps them to the release's Fabric jar and its
// SHA-1, checked against the files published on GitHub.

const RELEASES = [
  { tag: '1.7.3', sha1: '83a9062fcaf0c7e2cb32dd46b02dd961b01ab1e2', mc: ['1.17', '1.17.1'] },
  { tag: '1.8.2', sha1: 'aafe37557c5f38e098bc5ae06791c7af98c4ab34', mc: ['1.18', '1.18.1'] },
  { tag: '1.8.6', sha1: '99f6d55e42167accfb718a92f6d431f96ff6ee37', mc: ['1.18.2'] },
  { tag: '1.9.4', sha1: 'c0bb5ce11c8b0a357d4a7f2e3068ef6fe47da892', mc: ['1.19.2'] },
  { tag: '1.9.1', sha1: 'bc6353bacd3e44fb4b8183b63318f6d820dd54ed', mc: ['1.19.3'] },
  { tag: '1.9.6', sha1: '7650ddae33593f9c70293b3e5431e492c3a6647c', mc: ['1.19.4'] },
  { tag: '1.10.5', sha1: '99bfa245f35249006eb6d231f027b06c579b9ce8', mc: ['1.20', '1.20.1'] },
  { tag: '1.10.6', sha1: '59fab8be3d662934c689214dfd022f747d141e47', mc: ['1.20.2'] },
  { tag: '1.10.7', sha1: '318289e7b4a8d85d27783a601a02c5859cd0c6dd', mc: ['1.20.3', '1.20.4'] },
  { tag: '1.10.8', sha1: 'ee43e9de46e91e89e144b0633df07523f08e4745', mc: ['1.20.5', '1.20.6'] },
  { tag: '1.11.3', sha1: '4f2a62018eaa8c99a60909d8789c5d6044b1b34b', mc: ['1.21', '1.21.1'] },
  { tag: '1.12.0', sha1: '65fe3149da3e6c4a750425c8155c2d9fb290fcc5', mc: ['1.21.2', '1.21.3'] },
  { tag: '1.13.1', sha1: '1c9a1658381f8306fae105752de181d019f5a23f', mc: ['1.21.4'] },
  { tag: '1.14.0', sha1: '254e236bd8fbe55272f5f5f53dc4750dc507b5d1', mc: ['1.21.5'] },
  { tag: '1.15.0', sha1: '3584f1067f0b114c4ff2925a0b45bc51e2f4a03e', mc: ['1.21.6', '1.21.7', '1.21.8'] },
  { tag: '1.16.0', sha1: '1f2b5f6597d60a077c1e9ab419db978a03e514f9', mc: ['1.21.9', '1.21.10'] },
  { tag: '1.17.0', sha1: '53076639f7460d1ddd95d530e2c04cfea1a3373d', mc: ['1.21.11'] },
  { tag: '1.18.0', sha1: '8d1caa64ad04b447e636f86d5444f921adc58690', mc: ['26.1', '26.1.1', '26.1.2'] },
  { tag: '1.19.0', sha1: 'f3649ceea55386950e624afe09ee7a7b13ecf79c', mc: ['26.2'] },
  { tag: '1.20.0', sha1: '5a1e36c9ce73c7aaa9bce5bdd191b14a469f31c9', mc: ['26.3'] },
];

// The Baritone build for a Minecraft version, or null if there is none.
function forVersion(versionId) {
  const r = RELEASES.find((x) => x.mc.includes(versionId));
  if (!r) return null;
  const file = `baritone-standalone-fabric-${r.tag}.jar`;
  return {
    version: r.tag,
    file,
    url: `https://github.com/cabaletta/baritone/releases/download/v${r.tag}/${file}`,
    sha1: r.sha1,
  };
}

const supportedVersions = RELEASES.flatMap((r) => r.mc);

module.exports = { forVersion, supportedVersions };
