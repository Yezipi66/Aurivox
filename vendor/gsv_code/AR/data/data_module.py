# modified from https://github.com/yangdongchao/SoundStorm/blob/master/soundstorm/s1/AR/data/data_module.py
# reference: https://github.com/lifeiteng/vall-e
import sys

from pytorch_lightning import LightningDataModule
from torch.utils.data import DataLoader
import torch

# On Windows, tearing down persistent DataLoader worker processes at the end of
# trainer.fit() frequently crashes the interpreter with an access violation
# (exit code 0xC0000005) AFTER training + checkpointing have already succeeded.
# The Node pipeline then treats the non-zero exit as a training failure and
# discards a model that was in fact trained and saved. The datasets here are
# tiny (a few hundred lines), so worker processes buy nothing. Force in-process
# loading on Windows to make teardown deterministic and crash-free.
_IS_WINDOWS = sys.platform == "win32"


def _loader_mp_kwargs(requested_workers):
    """Return DataLoader multiprocessing kwargs that are safe on the current OS."""
    if _IS_WINDOWS or requested_workers <= 0:
        # num_workers=0 => single process; persistent_workers/prefetch_factor are
        # invalid with 0 workers and must be omitted.
        return {"num_workers": 0}
    return {
        "num_workers": requested_workers,
        "persistent_workers": True,
        "prefetch_factor": 16,
    }

from gsv_code.AR.data.bucket_sampler import DistributedBucketSampler
from gsv_code.AR.data.dataset import Text2SemanticDataset


class Text2SemanticDataModule(LightningDataModule):
    def __init__(
        self,
        config,
        train_semantic_path,
        train_phoneme_path,
        dev_semantic_path=None,
        dev_phoneme_path=None,
    ):
        super().__init__()
        self.config = config
        self.train_semantic_path = train_semantic_path
        self.train_phoneme_path = train_phoneme_path
        self.dev_semantic_path = dev_semantic_path
        self.dev_phoneme_path = dev_phoneme_path
        self.num_workers = self.config["data"]["num_workers"]

    def prepare_data(self):
        pass

    def setup(self, stage=None, output_logs=False):
        self._train_dataset = Text2SemanticDataset(
            phoneme_path=self.train_phoneme_path,
            semantic_path=self.train_semantic_path,
            max_sec=self.config["data"]["max_sec"],
            pad_val=self.config["data"]["pad_val"],
        )
        self._dev_dataset = self._train_dataset
        # self._dev_dataset = Text2SemanticDataset(
        #     phoneme_path=self.dev_phoneme_path,
        #     semantic_path=self.dev_semantic_path,
        #     max_sample=self.config['data']['max_eval_sample'],
        #     max_sec=self.config['data']['max_sec'],
        #     pad_val=self.config['data']['pad_val'])

    def train_dataloader(self):
        batch_size = (
            self.config["train"]["batch_size"] // 2
            if self.config["train"].get("if_dpo", False) is True
            else self.config["train"]["batch_size"]
        )
        batch_size = max(min(batch_size, len(self._train_dataset) // 4), 1)  # 防止不保存
        if torch.distributed.is_initialized():
            sampler = DistributedBucketSampler(self._train_dataset, batch_size=batch_size)
            dl_kwargs = dict(sampler=sampler, batch_size=batch_size)
        else:
            dl_kwargs = dict(batch_size=batch_size, shuffle=True)
        return DataLoader(
            self._train_dataset,
            collate_fn=self._train_dataset.collate,
            **_loader_mp_kwargs(self.num_workers),
            **dl_kwargs
        )

    def val_dataloader(self):
        return DataLoader(
            self._dev_dataset,
            batch_size=1,
            shuffle=False,
            collate_fn=self._train_dataset.collate,
            **_loader_mp_kwargs(max(self.num_workers, 12)),
        )

    # 这个会使用到嘛？
    def test_dataloader(self):
        return DataLoader(
            self._dev_dataset,
            batch_size=1,
            shuffle=False,
            collate_fn=self._train_dataset.collate,
        )
