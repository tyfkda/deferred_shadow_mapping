import {mat4, vec3, vec4} from 'https://wgpu-matrix.org/dist/2.x/wgpu-matrix.module.js'
import {mesh} from './stanford-dragon.js'

const kMaxNumLights = 1024;
const lightExtentMin = vec3.fromValues(-50, -30, -50);
const lightExtentMax = vec3.fromValues(50, 50, 50);

class PointLight {
    constructor(device, lightsBufferBindGroupLayout, configUniformBuffer, cameraUniformBuffer) {
        const extent = vec3.sub(lightExtentMax, lightExtentMin);
        const lightData = new Float32Array(8);
        const tmpVec4 = vec4.create();
        // position
        for (let i = 0; i < 3; i++) {
            lightData[i] = Math.random() * extent[i] + lightExtentMin[i];
        }
        lightData[3] = 1;
        // color
        lightData[4 + 0] = Math.random() * 2;
        lightData[4 + 1] = Math.random() * 2;
        lightData[4 + 2] = Math.random() * 2;
        // radius
        // lightData[4 + 3] = 20.0;
        lightData[4 + 3] = 50.0;

        this.lightData = lightData


        const lightDataStride = 8;
        const bufferSizeInByte = Float32Array.BYTES_PER_ELEMENT * lightDataStride * 1;
        this.lightsBuffer = device.createBuffer({
            size: bufferSizeInByte,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            // mappedAtCreation: true,
        });
        device.queue.writeBuffer(this.lightsBuffer, /*bufferOffset=*/0, this.lightData);


        const bindGroup = device.createBindGroup({
            layout: lightsBufferBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: this.lightsBuffer,
                    },
                },
                {
                    binding: 1,
                    resource: {
                        buffer: configUniformBuffer,
                    },
                },
                {
                    binding: 2,
                    resource: {
                        buffer: cameraUniformBuffer,
                    },
                },
            ],
        });
        this.bindGroup = bindGroup
    }

    update(device) {
        let y = this.lightData[1]
        y -= 0.3
        if (y < lightExtentMin[1])
            y = lightExtentMax[1]
        this.lightData[1] = y

        device.queue.writeBuffer(this.lightsBuffer, /*bufferOffset=*/0, this.lightData);
    }
}

const init /*: SampleInit*/ = async ({ canvas /*, pageState, gui*/ }) => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();

    // if (!pageState.active) return;
    const context = canvas.getContext('webgpu') /*as GPUCanvasContext*/;

    let lightUpdate
    let vertexWriteGBuffers
    let fragmentWriteGBuffers
    let vertexTextureQuad
    let fragmentGBuffersDebugView
    let fragmentDeferredRendering

    await Promise.all([
        fetch('./lightUpdate.wgsl').then((r) => r.text()).then((r) => lightUpdate = r),
        fetch('./vertexWriteGBuffers.wgsl').then((r) => r.text()).then((r) => vertexWriteGBuffers = r),
        fetch('./fragmentWriteGBuffers.wgsl').then((r) => r.text()).then((r) => fragmentWriteGBuffers = r),
        fetch('./vertexTextureQuad.wgsl').then((r) => r.text()).then((r) => vertexTextureQuad = r),
        fetch('./fragmentGBuffersDebugView.wgsl').then((r) => r.text()).then((r) => fragmentGBuffersDebugView = r),
        fetch('./fragmentDeferredRendering.wgsl').then((r) => r.text()).then((r) => fragmentDeferredRendering = r),
    ])

    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    const aspect = canvas.width / canvas.height;
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device,
        format: presentationFormat,
        alphaMode: 'premultiplied',
    });

    // Create the model vertex buffer.
    const kVertexStride = 8;
    const vertexBuffer = device.createBuffer({
        // position: vec3, normal: vec3, uv: vec2
        size:
            mesh.positions.length * kVertexStride * Float32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.VERTEX,
        mappedAtCreation: true,
    });
    {
        const mapping = new Float32Array(vertexBuffer.getMappedRange());
        for (let i = 0; i < mesh.positions.length; ++i) {
            mapping.set(mesh.positions[i], kVertexStride * i);
            mapping.set(mesh.normals[i], kVertexStride * i + 3);
            mapping.set(mesh.uvs[i], kVertexStride * i + 6);
        }
        vertexBuffer.unmap();
    }

    // Create the model index buffer.
    const indexCount = mesh.triangles.length * 3;
    const indexBuffer = device.createBuffer({
        size: indexCount * Uint16Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.INDEX,
        mappedAtCreation: true,
    });
    {
        const mapping = new Uint16Array(indexBuffer.getMappedRange());
        for (let i = 0; i < mesh.triangles.length; ++i) {
            mapping.set(mesh.triangles[i], 3 * i);
        }
        indexBuffer.unmap();
    }

    // GBuffer texture render targets
    const gBufferTexture2DFloat16 = device.createTexture({
        size: [canvas.width, canvas.height],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        format: 'rgba16float',
    });
    const gBufferTextureAlbedo = device.createTexture({
        size: [canvas.width, canvas.height],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        format: 'bgra8unorm',
    });
    const depthTexture = device.createTexture({
        size: [canvas.width, canvas.height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    const gBufferTextureViews = [
        gBufferTexture2DFloat16.createView(),
        gBufferTextureAlbedo.createView(),
        depthTexture.createView(),
    ];

    const vertexBuffers /*: Iterable<GPUVertexBufferLayout>*/ = [
        {
            arrayStride: Float32Array.BYTES_PER_ELEMENT * 8,
            attributes: [
                {
                    // position
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x3',
                },
                {
                    // normal
                    shaderLocation: 1,
                    offset: Float32Array.BYTES_PER_ELEMENT * 3,
                    format: 'float32x3',
                },
                {
                    // uv
                    shaderLocation: 2,
                    offset: Float32Array.BYTES_PER_ELEMENT * 6,
                    format: 'float32x2',
                },
            ],
        },
    ];

    const primitive /*: GPUPrimitiveState*/ = {
        topology: 'triangle-list',
        cullMode: 'back',
    };

    const writeGBuffersPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
            module: device.createShaderModule({
                code: vertexWriteGBuffers,
            }),
            entryPoint: 'main',
            buffers: vertexBuffers,
        },
        fragment: {
            module: device.createShaderModule({
                code: fragmentWriteGBuffers,
            }),
            entryPoint: 'main',
            targets: [
                // normal
                { format: 'rgba16float' },
                // albedo
                { format: 'bgra8unorm' },
            ],
        },
        depthStencil: {
            depthWriteEnabled: true,
            depthCompare: 'less',
            format: 'depth24plus',
        },
        primitive,
    });

    const gBufferTexturesBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {
                    sampleType: 'unfilterable-float',
                },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {
                    sampleType: 'unfilterable-float',
                },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {
                    sampleType: 'depth',
                },
            },
        ],
    });

    const lightsBufferBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'read-only-storage',
                },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'uniform',
                },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: {
                    type: 'uniform',
                },
            },
        ],
    });

    const gBuffersDebugViewPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [gBufferTexturesBindGroupLayout],
        }),
        vertex: {
            module: device.createShaderModule({
                code: vertexTextureQuad,
            }),
            entryPoint: 'main',
        },
        fragment: {
            module: device.createShaderModule({
                code: fragmentGBuffersDebugView,
            }),
            entryPoint: 'main',
            targets: [
                {
                    format: presentationFormat,
                },
            ],
            constants: {
                canvasSizeWidth: canvas.width,
                canvasSizeHeight: canvas.height,
            },
        },
        primitive,
    });

    const deferredRenderPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                gBufferTexturesBindGroupLayout,
                lightsBufferBindGroupLayout,
            ],
        }),
        vertex: {
            module: device.createShaderModule({
                code: vertexTextureQuad,
            }),
            entryPoint: 'main',
        },
        fragment: {
            module: device.createShaderModule({
                code: fragmentDeferredRendering,
            }),
            entryPoint: 'main',
            targets: [
                {
                    format: presentationFormat,
                    blend: {
                        color: {
                            srcFactor: 'one',
                            dstFactor: 'src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'zero',
                            operation: 'add',
                        },
                    },
                },
            ],
        },
        primitive,
    });

    const writeGBufferPassDescriptor /*: GPURenderPassDescriptor*/ = {
        colorAttachments: [
            {
                view: gBufferTextureViews[0],

                clearValue: { r: 0.0, g: 0.0, b: 1.0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            },
            {
                view: gBufferTextureViews[1],

                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            },
        ],
        depthStencilAttachment: {
            view: depthTexture.createView(),

            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        },
    };

    const textureQuadPassDescriptor /*: GPURenderPassDescriptor*/ = {
        colorAttachments: [
            {
                // view is acquired and set in render loop.
                view: undefined,

                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            },
        ],
    };
    const textureQuadPassDescriptorWithoutClear /*: GPURenderPassDescriptor*/ = {
        colorAttachments: [
            {
                // view is acquired and set in render loop.
                view: undefined,
                loadOp: 'load',
                storeOp: 'store',
            },
        ],
    };

    const settings = {
        mode: 'rendering',
        // numLights: 4,
        numLights: 8,
    };
    const configUniformBuffer = (() => {
        const buffer = device.createBuffer({
            size: Uint32Array.BYTES_PER_ELEMENT,
            mappedAtCreation: true,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        new Uint32Array(buffer.getMappedRange())[0] = settings.numLights;
        buffer.unmap();
        return buffer;
    })();

    // gui.add(settings, 'mode', ['rendering', 'gBuffers view']);
    // gui
    //     .add(settings, 'numLights', 1, kMaxNumLights)
    //     .step(1)
    //     .onChange(() => {
    //         device.queue.writeBuffer(
    //             configUniformBuffer,
    //             0,
    //             new Uint32Array([settings.numLights])
    //         );
    //     });

    const modelUniformBuffer = device.createBuffer({
        size: 4 * 16 * 2, // two 4x4 matrix
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const cameraUniformBuffer = device.createBuffer({
        size: 4 * 16 * 2, // two 4x4 matrix
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const sceneUniformBindGroup = device.createBindGroup({
        layout: writeGBuffersPipeline.getBindGroupLayout(0),
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: modelUniformBuffer,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: cameraUniformBuffer,
                },
            },
        ],
    });

    const gBufferTexturesBindGroup = device.createBindGroup({
        layout: gBufferTexturesBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: gBufferTextureViews[0],
            },
            {
                binding: 1,
                resource: gBufferTextureViews[1],
            },
            {
                binding: 2,
                resource: gBufferTextureViews[2],
            },
        ],
    });

    // Lights data are uploaded in a storage buffer
    // which could be updated/culled/etc. with a compute shader
    const extent = vec3.sub(lightExtentMax, lightExtentMin);
    const lightDataStride = 8;
    const bufferSizeInByte =
        Float32Array.BYTES_PER_ELEMENT * lightDataStride * kMaxNumLights;
    const lightsBuffer = device.createBuffer({
        size: bufferSizeInByte,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true,
    });

    // We randomaly populate lights randomly in a box range
    // And simply move them along y-axis per frame to show they are
    // dynamic lightings
    const lightData = new Float32Array(lightsBuffer.getMappedRange());
    const tmpVec4 = vec4.create();
    let offset = 0;
    for (let i = 0; i < kMaxNumLights; i++) {
        offset = lightDataStride * i;
        // position
        for (let i = 0; i < 3; i++) {
            tmpVec4[i] = Math.random() * extent[i] + lightExtentMin[i];
        }
        tmpVec4[3] = 1;
        lightData.set(tmpVec4, offset);
        // color
        tmpVec4[0] = Math.random() * 2;
        tmpVec4[1] = Math.random() * 2;
        tmpVec4[2] = Math.random() * 2;
        // radius
        tmpVec4[3] = 20.0;
        lightData.set(tmpVec4, offset + 4);
    }
    lightsBuffer.unmap();

    const lightExtentBuffer = device.createBuffer({
        size: 4 * 8,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const lightExtentData = new Float32Array(8);
    lightExtentData.set(lightExtentMin, 0);
    lightExtentData.set(lightExtentMax, 4);
    device.queue.writeBuffer(
        lightExtentBuffer,
        0,
        lightExtentData.buffer,
        lightExtentData.byteOffset,
        lightExtentData.byteLength
    );

    const lightUpdateComputePipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
            module: device.createShaderModule({
                code: lightUpdate,
            }),
            entryPoint: 'main',
        },
    });
    const lightsBufferBindGroup = device.createBindGroup({
        layout: lightsBufferBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: lightsBuffer,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: configUniformBuffer,
                },
            },
            {
                binding: 2,
                resource: {
                    buffer: cameraUniformBuffer,
                },
            },
        ],
    });
    const lightsBufferComputeBindGroup = device.createBindGroup({
        layout: lightUpdateComputePipeline.getBindGroupLayout(0),
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: lightsBuffer,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: configUniformBuffer,
                },
            },
            {
                binding: 2,
                resource: {
                    buffer: lightExtentBuffer,
                },
            },
        ],
    });


    const pointLights = []
    for (let i = 0; i < kMaxNumLights; ++i) {
        pointLights.push(new PointLight(device, lightsBufferBindGroupLayout, configUniformBuffer, cameraUniformBuffer))
    }



    //--------------------

    // Scene matrices
    const eyePosition = vec3.fromValues(0, 50, -100);
    const upVector = vec3.fromValues(0, 1, 0);
    const origin = vec3.fromValues(0, 0, 0);

    const projectionMatrix = mat4.perspective(
        (2 * Math.PI) / 5,
        aspect,
        1,
        2000.0
    );

    const viewMatrix = mat4.inverse(mat4.lookAt(eyePosition, origin, upVector));

    const viewProjMatrix = mat4.multiply(projectionMatrix, viewMatrix);

    // Move the model so it's centered.
    const modelMatrix = mat4.translation([0, -45, 0]);

    const modelData = modelMatrix /*as Float32Array*/;
    device.queue.writeBuffer(
        modelUniformBuffer,
        0,
        modelData.buffer,
        modelData.byteOffset,
        modelData.byteLength
    );
    const invertTransposeModelMatrix = mat4.invert(modelMatrix);
    mat4.transpose(invertTransposeModelMatrix, invertTransposeModelMatrix);
    const normalModelData = invertTransposeModelMatrix /*as Float32Array*/;
    device.queue.writeBuffer(
        modelUniformBuffer,
        64,
        normalModelData.buffer,
        normalModelData.byteOffset,
        normalModelData.byteLength
    );

    // Rotates the camera around the origin based on time.
    function getCameraViewProjMatrix() {
        const eyePosition = vec3.fromValues(0, 50, -100);

        const rad = Math.PI * (Date.now() / 5000);
        const rotation = mat4.rotateY(mat4.translation(origin), rad);
        vec3.transformMat4(eyePosition, rotation, eyePosition);
        const rotatedEyePosition = vec3.transformMat4(eyePosition, rotation);

        const viewMatrix = mat4.lookAt(rotatedEyePosition, origin, upVector);

        mat4.multiply(projectionMatrix, viewMatrix, viewProjMatrix);
        return viewProjMatrix /*as Float32Array*/;
    }

    function frame() {
        // Sample is no longer the active page.
        // if (!pageState.active) return;

        const cameraViewProj = getCameraViewProjMatrix();
        device.queue.writeBuffer(
            cameraUniformBuffer,
            0,
            cameraViewProj.buffer,
            cameraViewProj.byteOffset,
            cameraViewProj.byteLength
        );
        const cameraInvViewProj = mat4.invert(cameraViewProj) /*as Float32Array*/;
        device.queue.writeBuffer(
            cameraUniformBuffer,
            64,
            cameraInvViewProj.buffer,
            cameraInvViewProj.byteOffset,
            cameraInvViewProj.byteLength
        );

        for (let i = 0; i < settings.numLights; ++i) {
            const pointLight = pointLights[i]
            pointLight.update(device)
        }

        const commandEncoder = device.createCommandEncoder();
        {
            // Write position, normal, albedo etc. data to gBuffers
            const gBufferPass = commandEncoder.beginRenderPass(
                writeGBufferPassDescriptor
            );
            gBufferPass.setPipeline(writeGBuffersPipeline);
            gBufferPass.setBindGroup(0, sceneUniformBindGroup);
            gBufferPass.setVertexBuffer(0, vertexBuffer);
            gBufferPass.setIndexBuffer(indexBuffer, 'uint16');
            gBufferPass.drawIndexed(indexCount);
            gBufferPass.end();
        }
        // {
        //     // Update lights position
        //     const lightPass = commandEncoder.beginComputePass();
        //     lightPass.setPipeline(lightUpdateComputePipeline);
        //     lightPass.setBindGroup(0, lightsBufferComputeBindGroup);
        //     lightPass.dispatchWorkgroups(Math.ceil(kMaxNumLights / 64));
        //     lightPass.end();
        // }
        {
            if (settings.mode === 'gBuffers view') {
                // GBuffers debug view
                // Left: depth
                // Middle: normal
                // Right: albedo (use uv to mimic a checkerboard texture)
                textureQuadPassDescriptor.colorAttachments[0].view = context
                    .getCurrentTexture()
                    .createView();
                const debugViewPass = commandEncoder.beginRenderPass(
                    textureQuadPassDescriptor
                );
                debugViewPass.setPipeline(gBuffersDebugViewPipeline);
                debugViewPass.setBindGroup(0, gBufferTexturesBindGroup);
                debugViewPass.draw(6);
                debugViewPass.end();
            } else {
                // Deferred rendering
                const view = context.getCurrentTexture().createView();
                textureQuadPassDescriptor.colorAttachments[0].view = view
                textureQuadPassDescriptorWithoutClear.colorAttachments[0].view = view
                let desc = textureQuadPassDescriptor;
                for (let i = 0; i < settings.numLights; ++i) {
                    const pointLight = pointLights[i]
                    const deferredRenderingPass = commandEncoder.beginRenderPass(desc)
                    deferredRenderingPass.setPipeline(deferredRenderPipeline);
                    deferredRenderingPass.setBindGroup(0, gBufferTexturesBindGroup);
                    deferredRenderingPass.setBindGroup(1, pointLight.bindGroup);
                    deferredRenderingPass.draw(6);
                    deferredRenderingPass.end();
                    desc = textureQuadPassDescriptorWithoutClear
                }
            }
        }
        device.queue.submit([commandEncoder.finish()]);

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
};

async function main() {
    const canvas = document.querySelector('canvas')

    await init({canvas})
}

await main()