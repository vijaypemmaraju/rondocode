import torch

FFT_SIZES = (2048, 1024, 512, 256, 128, 64)


def multiscale_stft_loss(
    x: torch.Tensor, y: torch.Tensor, fft_sizes: tuple[int, ...] = FFT_SIZES
) -> torch.Tensor:
    loss = x.new_zeros(())
    for n_fft in fft_sizes:
        win = torch.hann_window(n_fft, device=x.device)
        sx = torch.stft(
            x, n_fft, hop_length=n_fft // 4, window=win, return_complex=True
        ).abs()
        sy = torch.stft(
            y, n_fft, hop_length=n_fft // 4, window=win, return_complex=True
        ).abs()
        loss = loss + (sx - sy).abs().mean()
        loss = loss + (torch.log(sx + 1e-5) - torch.log(sy + 1e-5)).abs().mean()
    return loss
