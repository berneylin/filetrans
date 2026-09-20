import { describe, expect, it } from 'vitest'
import {
  buildAskpassScript,
  buildRshScript,
  buildRsyncArgs,
  buildSshConfig,
  knownHostsLine,
  parseHostKeyAlgorithm,
  withTrailingSlash
} from '../src/main/rsync/args'

const base = {
  localPath: '/home/user/models',
  remotePath: '/mnt/pfs/code/models',
  user: 'root',
  host: '10.0.0.2',
  rsh: '/tmp/rsh',
  deleteExtraneous: false,
  exclude: ['.venv*'],
  compress: true,
  modernGnu: true,
  progress2: true,
  zstd: true
}

describe('buildRsyncArgs', () => {
  it('上传时源带尾部斜杠（内容镜像），本地在前', () => {
    const args = buildRsyncArgs({ ...base, direction: 'upload' })
    expect(args).toEqual([
      '-a',
      '-s',
      '--partial',
      '--no-owner',
      '--no-group',
      '--info=progress2,name',
      '--exclude=.venv*',
      '--zc=zstd',
      '-e',
      '/tmp/rsh',
      '/home/user/models/',
      'root@10.0.0.2:/mnt/pfs/code/models'
    ])
  })

  it('下载时远程源带尾部斜杠（内容镜像），远程在前', () => {
    const args = buildRsyncArgs({ ...base, direction: 'download' })
    expect(args[args.length - 2]).toBe('root@10.0.0.2:/mnt/pfs/code/models/')
    expect(args[args.length - 1]).toBe('/home/user/models/')
  })

  it('已带斜杠的本地路径不重复添加', () => {
    const args = buildRsyncArgs({ ...base, direction: 'upload', localPath: '/a/b/' })
    expect(args[args.length - 2]).toBe('/a/b/')
  })

  it('空排除项被过滤，delete 开关生效，compress 关闭时无 zstd', () => {
    const args = buildRsyncArgs({
      ...base,
      direction: 'upload',
      deleteExtraneous: true,
      compress: false,
      exclude: ['.venv*', '  ', 'node_modules']
    })
    expect(args.filter((a) => a.startsWith('--exclude'))).toEqual([
      '--exclude=.venv*',
      '--exclude=node_modules'
    ])
    expect(args).toContain('--delete')
    expect(args).not.toContain('--zc=zstd')
  })

  it('排除项两端空白被裁剪', () => {
    const args = buildRsyncArgs({
      ...base,
      direction: 'upload',
      exclude: [' *.log ']
    })
    expect(args).toContain('--exclude=*.log')
  })

  it('openrsync 使用兼容参数（无 -s/--info/--no-owner，压缩降级 -z）', () => {
    const args = buildRsyncArgs({ ...base, direction: 'upload', modernGnu: false })
    expect(args).toEqual([
      '-rlptD',
      '--partial',
      '--progress',
      '--exclude=.venv*',
      '-z',
      '-e',
      '/tmp/rsh',
      '/home/user/models/',
      'root@10.0.0.2:/mnt/pfs/code/models'
    ])
  })

  it('openrsync 关闭压缩时不带 -z', () => {
    const args = buildRsyncArgs({
      ...base,
      direction: 'upload',
      modernGnu: false,
      compress: false
    })
    expect(args).not.toContain('-z')
    expect(args).not.toContain('--zc=zstd')
  })

  it('openrsync 远端路径含空格时单引号包裹（下载方向同样处理）', () => {
    const args = buildRsyncArgs({
      ...base,
      direction: 'download',
      modernGnu: false,
      compress: false,
      remotePath: "/mnt/my dir/it's"
    })
    expect(args[args.length - 2]).toBe("root@10.0.0.2:'/mnt/my dir/it'\\''s/'")
  })

  it('现代 GNU 下远端路径不加引号（依赖 -s）', () => {
    const args = buildRsyncArgs({ ...base, direction: 'upload', remotePath: '/mnt/my dir' })
    expect(args[args.length - 1]).toBe('root@10.0.0.2:/mnt/my dir')
  })

  it('远端不支持 progress2 时改用 --progress；本地 rsync 自带参数转义时不加引号', () => {
    const args = buildRsyncArgs({
      ...base,
      direction: 'upload',
      progress2: false,
      argProtected: true,
      remotePath: '/mnt/my dir'
    })
    expect(args).not.toContain('-s')
    expect(args).toContain('--progress')
    expect(args).not.toContain('--info=progress2,name')
    expect(args[args.length - 1]).toBe('root@10.0.0.2:/mnt/my dir')
  })

  it('本地 rsync 低于 3.2.4 时仍需手工给特殊路径加引号', () => {
    const args = buildRsyncArgs({
      ...base,
      direction: 'upload',
      progress2: false,
      argProtected: false,
      remotePath: '/mnt/my dir'
    })
    expect(args).not.toContain('-s')
    expect(args).toContain('--progress')
    expect(args[args.length - 1]).toBe("root@10.0.0.2:'/mnt/my dir'")
  })

  it('progress2 开启时即使本地无参数转义也不加引号（-s 走协议下发）', () => {
    const args = buildRsyncArgs({
      ...base,
      direction: 'upload',
      progress2: true,
      argProtected: false,
      remotePath: '/mnt/my dir'
    })
    expect(args).toContain('-s')
    expect(args[args.length - 1]).toBe('root@10.0.0.2:/mnt/my dir')
  })

  it('远端无 zstd 时压缩降级为 -z', () => {
    const args = buildRsyncArgs({ ...base, direction: 'upload', zstd: false })
    expect(args).toContain('-z')
    expect(args).not.toContain('--zc=zstd')
  })

  it('withTrailingSlash 根路径安全', () => {
    expect(withTrailingSlash('/')).toBe('/')
    expect(withTrailingSlash('/a')).toBe('/a/')
  })
})

describe('buildSshConfig', () => {
  it('包含主机端口用户与严格主机校验', () => {
    const config = buildSshConfig({
      host: '10.0.0.5',
      port: 2222,
      user: 'root',
      knownHostsFile: '/tmp/kh'
    })
    expect(config).toContain('Host *')
    expect(config).toContain('HostName "10.0.0.5"')
    expect(config).toContain('Port 2222')
    expect(config).toContain('User "root"')
    expect(config).toContain('StrictHostKeyChecking yes')
    expect(config).toContain('UserKnownHostsFile "/tmp/kh"')
    expect(config).toContain('IdentityAgent none')
    expect(config).toContain('NumberOfPasswordPrompts 1')
    expect(config).not.toContain('IdentityFile')
  })

  it('提供密钥路径时写入 IdentityFile 与 IdentitiesOnly', () => {
    const config = buildSshConfig({
      host: 'h',
      port: 22,
      user: 'u',
      knownHostsFile: '/tmp/kh',
      keyPath: '/home/u/.ssh/id_ed25519'
    })
    expect(config).toContain('IdentityFile "/home/u/.ssh/id_ed25519"')
    expect(config).toContain('IdentitiesOnly yes')
  })

  it('包含非法字符的路径抛错', () => {
    expect(() =>
      buildSshConfig({ host: 'h', port: 22, user: 'u', knownHostsFile: '/tmp/a"b' })
    ).toThrow()
  })
})

describe('buildRshScript / buildAskpassScript', () => {
  it('rsh 脚本引用配置文件并透传参数', () => {
    const script = buildRshScript('/tmp/dir/config')
    expect(script).toContain('exec ssh -F "/tmp/dir/config" "$@"')
  })

  it('askpass 脚本从环境变量读取密钥', () => {
    expect(buildAskpassScript()).toContain('$FILETRANS_SSH_SECRET')
  })

  it('配置路径包含引号时抛错', () => {
    expect(() => buildRshScript('/tmp/a"b/config')).toThrow()
  })
})

describe('parseHostKeyAlgorithm', () => {
  function blob(type: string): Buffer {
    const typeBuf = Buffer.from(type, 'ascii')
    const head = Buffer.alloc(4)
    head.writeUInt32BE(typeBuf.length, 0)
    return Buffer.concat([head, typeBuf, Buffer.from([1, 2, 3])])
  }

  it('解析公钥 blob 中的算法名', () => {
    expect(parseHostKeyAlgorithm(blob('ssh-ed25519'))).toBe('ssh-ed25519')
    expect(parseHostKeyAlgorithm(blob('ssh-rsa'))).toBe('ssh-rsa')
  })

  it('非法输入返回 null', () => {
    expect(parseHostKeyAlgorithm(Buffer.alloc(0))).toBe(null)
    expect(parseHostKeyAlgorithm(Buffer.from([0, 0, 0, 40]))).toBe(null)
    expect(parseHostKeyAlgorithm(blob('bad type!'))).toBe(null)
  })
})

describe('knownHostsLine', () => {
  it('默认端口使用裸主机名', () => {
    expect(knownHostsLine('h.com', 22, 'ssh-ed25519', 'AAA=')).toBe('h.com ssh-ed25519 AAA=\n')
  })

  it('非默认端口使用括号形式', () => {
    expect(knownHostsLine('h.com', 2222, 'ssh-rsa', 'BBB=')).toBe('[h.com]:2222 ssh-rsa BBB=\n')
  })
})
