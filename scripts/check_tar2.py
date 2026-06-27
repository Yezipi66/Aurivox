import os, tarfile

dst = r'C:\Users\MECHREVO X10 Pro\Desktop\tts_broker_src.tar.gz'
t = tarfile.open(dst, 'r:gz')
sizes = [(m.size, m.name) for m in t.getmembers()]
sizes.sort(reverse=True)
total = sum(s for s, _ in sizes)
print(f'Total: {total/1024/1024:.1f} MB, {len(sizes)} files')
print(f'\nTop 20 by size:')
for sz, name in sizes[:20]:
    print(f'  {sz/1024/1024:.1f} MB  {name}')

# group by top-level dir
print(f'\nBy top-level directory:')
dirs = {}
for sz, name in sizes:
    top = name.split('/')[0]
    dirs[top] = dirs.get(top, (0, 0))
    dirs[top] = (dirs[top][0] + sz, dirs[top][1] + 1)
for top, (sz, cnt) in sorted(dirs.items(), key=lambda x: -x[1][0]):
    print(f'  {sz/1024/1024:.1f} MB  ({cnt} files)  {top}/')
