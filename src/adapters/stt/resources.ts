export const WHISPER_VERSION = '1.9.2'
export const WHISPER_ARCHIVE_SHA256 = '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a'
export const SMALL_MODEL = {
  name: 'ggml-small.bin', size: 487_601_967,
  sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin?download=true'
} as const

/** Hashes from the SHA256-pinned upstream whisper-bin-x64 v1.9.2 release archive. */
export const WHISPER_FILES: Record<string, string> = {
  'ggml-base.dll': '1482359d921b4c1b183d49db1d770f9b5e90d86a618b8b648d4845c2471ad6b0',
  'ggml-cpu-alderlake.dll': 'd1c5411561361f7ce71ff8455ecf01f666f581b0608fa91a1dfe7d3fd6a25bd1',
  'ggml-cpu-cannonlake.dll': '2ef36f05fa252ff4fdcb8d42ebce1ceba4f3d3de12b93bed15bdee6237dccd63',
  'ggml-cpu-cascadelake.dll': '505899aaf3f99c5d714361640f561458ea97f8a09eb0614568a66bead2115cb0',
  'ggml-cpu-haswell.dll': 'f8cf2f35a06498d783d77fde42004dd54d2f8236b0d42ac323b94bba65a603c4',
  'ggml-cpu-icelake.dll': '78ad143ee2e674d037b4840ef33b5748a0659762a26e0ae2b621c4f9451cbde8',
  'ggml-cpu-sandybridge.dll': 'ee47db7dc40fb30eca73e62a05306059c2c3c42aecddf2e8d6ad7e530069b815',
  'ggml-cpu-skylakex.dll': '164e2793897944a43ee071ce6c0b09018088bdf4dd8b14ac0755c58849cf8c50',
  'ggml-cpu-sse42.dll': '7318a9a3b95a85b2453c437b274412bbbae89e5ecdf5babb19b99edc06ded063',
  'ggml-cpu-x64.dll': 'af0f1c2f28ff9e3f472481dd969907bda85fa39d4fde17617d4bb0b389301b60',
  'ggml.dll': '894c6237ee7849843213906a2b6a0b371aaa6234048d465f206d910ae846fafb',
  'whisper-server.exe': '9e581a4a2b7bd5aec0993f5794fea3d65af2d7f5921cf51c2a4e4b5a3a464d89',
  'whisper.dll': '792fc523c7ad16e6b9c348e30ad5e5f591165cbcf6a80ca8d0db02a38ce3eea2'
}
