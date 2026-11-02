import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildKinSeedJson,
  isHostKernel,
  KIN_SEED_SCHEMA,
  resolveWorkstationProfile,
  workstationFamily,
  workstationKernel,
  workstationSkuId,
} from '../../src/lib/identity/workstation-profile.mjs'

test('sku splits even 2c4g and odd 4c8g; missing id is 2c4g', () => {
  assert.equal(workstationSkuId({ id: 'vm-10' }), '2c4g')
  assert.equal(workstationSkuId({ id: 'vm-05' }), '4c8g')
  assert.equal(workstationSkuId({}), '2c4g')
})

test('family follows guest distro, not host kernel', () => {
  assert.equal(workstationFamily({ kernel: 'ubuntu-24.04' }), 'ubuntu')
  assert.equal(workstationFamily({ fingerprint: { os_id: 'debian' } }), 'debian')
  assert.equal(workstationFamily({ fingerprint: { os_id: 'arch' } }), 'arch')
  assert.equal(workstationFamily({ fingerprint: { kernel_release: '7.0.0-14-generic' } }), 'ubuntu')
})

test('kernel is distro generic and never the host 7.0.0-14-generic', () => {
  assert.equal(isHostKernel('7.0.0-14-generic'), true)
  assert.equal(isHostKernel('6.8.0-51-generic'), false)
  const ubuntu = resolveWorkstationProfile({
    id: 'vm-05',
    kernel: 'ubuntu-24.04',
    fingerprint: { os_id: 'ubuntu', os_pretty: 'Ubuntu 24.04.4 LTS', kernel_release: '7.0.0-14-generic' },
  })
  assert.equal(ubuntu.sku, '4c8g')
  assert.equal(ubuntu.linux_distro_id, 'ubuntu')
  assert.equal(ubuntu.linux_distro_version, '24.04.4')
  assert.equal(ubuntu.linux_kernel, '6.8.0-51-generic')
  assert.equal(ubuntu.os_version, 'Linux 6.8.0-51-generic')
  assert.equal(ubuntu.package_managers, 'apt')
  assert.equal(ubuntu.terminal, 'xterm-256color')
  assert.equal(ubuntu.process.constrained_memory, 0)
  assert.ok(!isHostKernel(ubuntu.linux_kernel))

  const debian = resolveWorkstationProfile({
    id: 'vm-10',
    kernel: 'debian-12',
    fingerprint: { os_id: 'debian', os_pretty: 'Debian GNU/Linux 12 (bookworm)', kernel_release: '7.0.0-14-generic' },
  })
  assert.equal(debian.sku, '2c4g')
  assert.equal(debian.linux_distro_id, 'debian')
  assert.match(debian.linux_kernel, /6\.1\.0-\d+-amd64/)
  assert.equal(debian.package_managers, 'apt')

  const arch = resolveWorkstationProfile({
    id: 'vm-11',
    kernel: 'archlinux',
    fingerprint: { os_id: 'arch', os_pretty: 'Arch Linux', kernel_release: '7.0.0-14-generic' },
  })
  assert.equal(arch.package_managers, 'pacman')
  assert.match(arch.linux_kernel, /arch1/)
  assert.notEqual(workstationKernel({ fingerprint: { kernel_release: '7.0.0-14-generic' } }), '7.0.0-14-generic')
})

test('kin-seed/2 records catalog kernel and workstation image', () => {
  const doc = buildKinSeedJson(
    {
      id: 'vm-05',
      kernel: 'ubuntu-24.04',
      timezone: 'America/Los_Angeles',
      locale: 'en_US.UTF-8',
      fingerprint: { kernel_release: '7.0.0-14-generic' },
    },
    { telemetry_disabled: false },
    { cli_version: '2.1.241' },
  )
  assert.equal(doc.schema, KIN_SEED_SCHEMA)
  assert.equal(doc.kernel, 'ubuntu-24.04')
  assert.equal(doc.linux_kernel, '6.8.0-51-generic')
  assert.equal(doc.workstation_sku, '4c8g')
  assert.equal(doc.telemetry, 'enabled')
  assert.equal(doc.cli_version, '2.1.241')
})
