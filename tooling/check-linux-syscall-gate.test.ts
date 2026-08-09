import { describe, expect, it } from 'vitest';

import { syscallMutations } from './check-linux-syscall-gate.js';

const output = '/tmp/local-pii-syscall/verified-output.txt';
const stage = '/tmp/local-pii-syscall/.verified-output.11111111-1111-4111-8111-111111111111.staged.txt';

describe('Linux syscall evidence parser', () => {
  it('allows only the exact private-stage creation, link publication, and cleanup sequence', () => {
    expect(syscallMutations([
      `openat(AT_FDCWD, "${stage}", O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC, 0600) = 18`,
      `link("${stage}", "${output}") = 0`,
      `unlink("${stage}") = 0`
    ], { output })).toEqual(['STAGE_CREATE', 'PUBLISH_LINK', 'STAGE_CLEANUP']);
  });

  it('rejects direct output writes, invalid stage identifiers, and extended mutator families', () => {
    expect(syscallMutations([
      `openat(AT_FDCWD, "${output}", O_WRONLY|O_CREAT|O_CLOEXEC, 0600) = 18`,
      'openat(AT_FDCWD, "/tmp/unrelated", O_TMPFILE|O_RDWR, 0600) = 18',
      'creat("/tmp/unrelated", 0600) = 18',
      'rename("/tmp/a", "/tmp/b") = 0',
      'setxattr("/tmp/a", "user.test", "x", 1, 0) = 0',
      'fchmod(18, 0644) = 0',
      'ftruncate(18, 0) = 0',
      'unlink("/tmp/local-pii-syscall/.verified-output.11111111-1111-3111-8111-111111111111.staged.txt") = 0'
    ], { output })).toEqual([
      'UNEXPECTED', 'UNEXPECTED', 'UNEXPECTED', 'UNEXPECTED', 'UNEXPECTED', 'UNEXPECTED', 'UNEXPECTED', 'UNEXPECTED'
    ]);
  });

  it('requires exclusive restrictive creation for a convention-matching stage', () => {
    expect(syscallMutations([
      `openat(AT_FDCWD, "${stage}", O_WRONLY|O_CREAT|O_CLOEXEC, 0600) = 18`,
      `openat(AT_FDCWD, "${stage}", O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC, 0644) = 18`,
      `openat(AT_FDCWD, "${stage}", O_WRONLY|O_CREAT|O_EXCL|O_TRUNC|O_CLOEXEC, 0600) = 18`
    ], { output })).toEqual(['UNEXPECTED', 'UNEXPECTED', 'UNEXPECTED']);
  });
});
