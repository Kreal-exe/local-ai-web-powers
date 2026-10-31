#!/bin/zsh
# Re-applies the MLX prefill chunk fix (2048 -> 512 tokens) after LM Studio updates its MLX engine.
# Fixes "[METAL] Insufficient Memory" on long prompts with big models on 16 GB Macs. No password needed.
SIZE=${1:-512}
[[ "$SIZE" == <-> ]] || { echo "The chunk size must be a number, e.g. 512"; exit 1; }
files=(~/.lmstudio/extensions/backends/vendor/_amphibian/app-mlx-generate-*/lib/python3.*/site-packages/mlx_engine/cache_wrapper.py(N))
(( ${#files} )) || { echo "LM Studio's MLX engine was not found (install an MLX model first)."; exit 1; }
for f in $files; do
  [ -f "$f.orig-2048" ] || cp "$f" "$f.orig-2048"
  sed -i '' -E "s/^PROMPT_PROCESSING_CHUNK_SIZE = [0-9]+.*/PROMPT_PROCESSING_CHUNK_SIZE = $SIZE  # patched for 16 GB Mac; original in .orig-2048/" "$f"
  echo "$f: $(grep '^PROMPT_PROCESSING_CHUNK_SIZE' "$f")"
done
echo "Done. Reload the model in LM Studio. Original files are kept as *.orig-2048."
