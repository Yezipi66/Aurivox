tools/wheels/
=============
放"需要编译环境"才能安装的 Python 轮子(.whl),让最终用户无需 C/C++ 编译器
即可离线安装它们。

由 tools/build/02_make_wheelhouse.bat 生成(在装有 VS2026 Build Tools 的机器上运行):
    - jieba_fast==0.53
    - pyopenjtalk==0.3.4

其余依赖在部署(bootstrap.ps1)时从 PyPI 联网安装,PyPI 有现成 cp311 wheel。
部署时的安装命令会自动带上  --find-links tools\wheels  优先使用这里的轮子。

注意:轮子是 cp311 / win_amd64 专用,必须与内嵌 Python 3.11 的 ABI 一致。
