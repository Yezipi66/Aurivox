tools/runtime/
==============
内嵌运行时(不占用系统 PATH,不需要用户安装 Python / Node):

  python/   python-build-standalone 的完整 CPython 3.11(可重定位,支持 venv/pip/C扩展)
            部署时用它创建项目根的 venv\
  node/     便携版 Node LTS,运行 server.js 后端

这两个目录由 tools/build/03_fetch_runtimes.py 下载填充:
    python tools\build\03_fetch_runtimes.py

发布打包(04_pack_release.py)会把它们一并打进 release zip,用户解压即有。
