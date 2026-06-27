import os, shutil

work_dir = r"D:\Project\tts_broker_openai_compat\test_raiden\日文"

# Delete 2-name2text-0.txt so BERT step runs
n2t_0 = os.path.join(work_dir, "2-name2text-0.txt")
if os.path.exists(n2t_0):
    os.remove(n2t_0)
    print(f"Deleted: {n2t_0}")

# Also clean 3-bert
bert_dir = os.path.join(work_dir, "3-bert")
if os.path.exists(bert_dir):
    shutil.rmtree(bert_dir)
    print(f"Deleted: {bert_dir}")

print("Cleaned!")
