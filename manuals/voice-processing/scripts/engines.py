"""Only these explicit local engines run. Profile JSON cannot execute commands."""
import gc
import os
from pathlib import Path
import sys


class Engines:
    def __init__(self, cfg):
        self.cfg = cfg
        self.model = None
        self.asr = None
        os.environ.update(HF_HOME=cfg["hf_cache"], HF_HUB_CACHE=str(Path(cfg["hf_cache"]) / "hub"),
                          HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", TOKENIZERS_PARALLELISM="false",
                          HF_HUB_DISABLE_PROGRESS_BARS="1")
        sys.path[:0] = [cfg["qwen_deps"], cfg["qwen_source"], cfg["runtime_root"]]

    def release(self):
        self.model = None
        self.asr = None
        gc.collect()
        if "torch" in sys.modules:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    def transcribe(self, source):
        import numpy as np
        import soundfile as sf
        import torch
        torch.set_num_threads(4)
        audio, rate = sf.read(source, dtype="float32")
        if rate != 16000 or not len(audio) or not np.isfinite(audio).all() or np.abs(audio).max() < 1e-5:
            raise ValueError("음성 인식 입력이 비어 있거나 무음입니다.")
        if self.asr is None:
            from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
            processor = AutoProcessor.from_pretrained(self.cfg["asr_model"], local_files_only=True)
            model = AutoModelForSpeechSeq2Seq.from_pretrained(self.cfg["asr_model"], dtype=torch.float16,
                                                              local_files_only=True, use_safetensors=True).to("cuda").eval()
            self.asr = pipeline("automatic-speech-recognition", model=model, tokenizer=processor.tokenizer,
                                feature_extractor=processor.feature_extractor, device=0, dtype=torch.float16)
        # Overlap prevents cutting words at fixed chunk boundaries. No alignment promise.
        result = self.asr({"raw": audio, "sampling_rate": rate}, chunk_length_s=25, stride_length_s=(3, 3),
                          batch_size=1, generate_kwargs=dict(language="ko", task="transcribe", num_beams=3,
                                                             do_sample=False, max_new_tokens=440))
        text = result["text"].strip()
        if not text:
            raise ValueError("말소리를 인식하지 못했습니다. 대사를 직접 입력하거나 다른 구간을 선택하세요.")
        return text

    def synthesize(self, pieces, profile, destination):
        import numpy as np
        import soundfile as sf
        import torch
        torch.set_num_threads(4)
        if self.model is None:
            from qwen_tts import Qwen3TTSModel
            self.model = Qwen3TTSModel.from_pretrained(self.cfg["tts_model"], device_map="cuda:0", dtype=torch.bfloat16,
                                                      attn_implementation="sdpa", local_files_only=True)
        generated = []
        for index, text in enumerate(pieces):
            torch.manual_seed(profile["seed"] + index)
            np.random.seed(profile["seed"] + index)
            wavs, rate = self.model.generate_custom_voice(text=text, language=profile["language"],
                                                         speaker=profile["speaker"], instruct=profile["instruction"],
                                                         max_new_tokens=600)
            data = wavs[0]
            if not len(data) or not np.isfinite(data).all() or not np.any(data):
                raise ValueError(f"{index + 1}번째 구간 합성에 실패했습니다.")
            if len(data) / rate >= 49:
                raise ValueError("생성 길이 제한에 도달했습니다. 대사를 더 짧게 나누세요.")
            if generated:
                generated.append(np.zeros(int(.2 * rate), dtype=np.float32))
            generated.append(data)
        sf.write(destination, np.concatenate(generated), rate, subtype="PCM_24")

    def finish(self, source, destination):
        # Keep the exact post-processing used for the user-selected baseline.
        from speech_convert import finish_audio
        finish_audio(Path(source), Path(destination), preserve_timbre=True)
