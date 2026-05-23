# MNIST Digit Model for Timing Sheet OCR

## Model: `mnist_digit_model.onnx`

This is a small CNN model trained on the MNIST handwritten digit dataset.
It classifies single 28×28 grayscale images into digits 0-9.

## Expected Input

- **Name**: `input` (or first input name)
- **Shape**: `[1, 1, 28, 28]` (batch, channels, height, width)
- **Type**: float32
- **Normalization**: pixels in range [0, 1], where 0 = white background, 1 = black ink (MNIST convention: inverted from raw grayscale)

## Expected Output

- **Name**: `output` (or first output name)
- **Shape**: `[1, 10]` (batch, classes)
- **Type**: float32 (logits — apply softmax for probabilities)
- **Classes**: index 0-9 corresponds to digit 0-9

## How to Obtain

### Option 1: Export from PyTorch

```python
import torch
import torch.nn as nn
import torch.onnx

class MNISTNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv2d(1, 32, 3, padding=1)
        self.conv2 = nn.Conv2d(32, 64, 3, padding=1)
        self.pool = nn.MaxPool2d(2, 2)
        self.fc1 = nn.Linear(64 * 7 * 7, 128)
        self.fc2 = nn.Linear(128, 10)
        self.relu = nn.ReLU()

    def forward(self, x):
        x = self.pool(self.relu(self.conv1(x)))
        x = self.pool(self.relu(self.conv2(x)))
        x = x.view(-1, 64 * 7 * 7)
        x = self.relu(self.fc1(x))
        x = self.fc2(x)
        return x

# Train on MNIST, then export:
model = MNISTNet()
# ... training code ...
dummy = torch.randn(1, 1, 28, 28)
torch.onnx.export(model, dummy, "mnist_digit_model.onnx",
                  input_names=["input"], output_names=["output"])
```

### Option 2: Download pre-trained

Search for "MNIST ONNX model" on:
- https://github.com/onnx/models
- https://huggingface.co/models?search=mnist+onnx

### Option 3: Use ONNX Model Zoo

The ONNX Model Zoo has a pre-trained MNIST model:
https://github.com/onnx/models/tree/main/validated/vision/classification/mnist

## Performance

- Model size: ~50-200KB depending on architecture
- Inference time: ~1ms per digit on CPU
- Accuracy on MNIST test set: >98%
- Accuracy on real handwriting: varies (60-90% without fine-tuning)

## Fine-tuning

To improve accuracy on actual judge handwriting:
1. Collect labeled digit samples from real timing sheets
2. Augment with rotation, scaling, noise
3. Fine-tune the model on the combined MNIST + real data
4. Re-export to ONNX
