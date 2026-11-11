export class Texture {
    readonly view: GPUTextureView;
    private readonly tex: GPUTexture;

    private constructor(tex: GPUTexture) {
        this.tex = tex;
        this.view = tex.createView();
    }

    static fromPixels(device: GPUDevice, data: Uint8Array, width: number, height: number): Texture {
        const tex = device.createTexture({
            size: {width, height},
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({texture: tex}, data, {bytesPerRow: width * 4}, {width, height});
        return new Texture(tex);
    }

    static async fromURL(device: GPUDevice, url: string): Promise<Texture> {
        const blob = await fetch(url).then((r) => r.blob());
        return Texture.fromBlob(device, blob);
    }

    static async fromBlob(device: GPUDevice, blob: Blob): Promise<Texture> {
        const bitmap = await createImageBitmap(blob);
        const tex = device.createTexture({
            size: {width: bitmap.width, height: bitmap.height},
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        device.queue.copyExternalImageToTexture(
            {source: bitmap},
            {texture: tex},
            {
                width: bitmap.width,
                height: bitmap.height,
            },
        );
        bitmap.close();
        return new Texture(tex);
    }

    destroy(): void {
        this.tex.destroy();
    }
}
