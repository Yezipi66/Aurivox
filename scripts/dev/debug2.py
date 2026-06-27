import subprocess, os

PYTHON = r"D:\Project\tts_broker_openai_compat\venv\Scripts\python.exe"
GSV_CODE = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-code"
PROJECT = r"D:\Project\tts_broker_openai_compat"

env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
env['PYTHONPATH'] = PROJECT + os.pathsep + GSV_CODE
env['PYTHONUNBUFFERED'] = '1'

# Debug: check what the child process sees
r = subprocess.run(
    [PYTHON, '-c', 'import sys; print("\\n".join(sys.path))'],
    capture_output=True, text=True, timeout=10, env=env
)
print("Child sys.path:")
print(r.stdout)
if r.stderr: print("stderr:", r.stderr[:200])

# Now try importing gsv_code
env['inp_text'] = r"D:\Project\tts_broker_openai_compat\test_raiden\日文\2-name2text.txt"
env['inp_wav_dir'] = ""
env['exp_name'] = "test"
env['i_part'] = "0"
env['all_parts'] = "1"
env['opt_dir'] = r"D:\Project\tts_broker_openai_compat\test_raiden\日文"
env['bert_pretrained_dir'] = r"D:\Project\tts_broker_openai_compat\lib\training\gsv-tools\pretrained\chinese-roberta-wwm-ext-large"
env['is_half'] = "True"
env['_CUDA_VISIBLE_DEVICES'] = "0"

r2 = subprocess.run(
    [PYTHON, '-c',
     'import sys; sys.path.insert(0, r"D:\\Project\\tts_broker_openai_compat"); sys.path.insert(0, r"D:\\Project\\tts_broker_openai_compat\\lib\\training\\gsv-code"); from gsv_code.text.cleaner import clean_text; print("OK")'],
    capture_output=True, text=True, timeout=10, env=env
)
print("\nDirect import test:")
print(r2.stdout)
if r2.stderr: print("stderr:", r2.stderr[:200])
