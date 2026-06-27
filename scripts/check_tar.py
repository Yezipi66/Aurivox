import tarfile

t = tarfile.open(r'C:\Users\MECHREVO X10 Pro\Desktop\tts_broker_src.tar.gz', 'r:gz')
total = 0
for m in t.getmembers():
    total += m.size
print(f'Total members: {len(t.getmembers())}, Total size: {total/1024/1024:.1f} MB')

# Check web/
web_files = [m for m in t.getmembers() if m.name.startswith('web/')]
print(f'web/ files: {len(web_files)}, size: {sum(m.size for m in web_files)/1024/1024:.1f} MB')

# Check gsv-tools
gsv = [m for m in t.getmembers() if m.name.startswith('gsv_tools/') or m.name.startswith('gsv-tools/')]
print(f'gsv-tools/ files: {len(gsv)}, size: {sum(m.size for m in gsv)/1024/1024:.1f} MB')

# Check node_modules
nm = [m for m in t.getmembers() if 'node_modules' in m.name]
print(f'node_modules files: {len(nm)}, size: {sum(m.size for m in nm)/1024/1024:.1f} MB')
