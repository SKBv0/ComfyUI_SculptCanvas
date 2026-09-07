import { describe, expect, it } from "vitest";
import { Object3D, Vector3 } from "three";
import {
    orientFbxRootToYUp,
    readFbxAxisSystem
} from "../scripts/parseThreeMeshEntry.js";

function binaryProperty(name, value) {
    const encoder = new TextEncoder();
    const chunks = [];
    const stringProperty = (text) => {
        const encoded = encoder.encode(text);
        const bytes = new Uint8Array(5 + encoded.length);
        const view = new DataView(bytes.buffer);
        bytes[0] = 0x53;
        view.setUint32(1, encoded.length, true);
        bytes.set(encoded, 5);
        return bytes;
    };
    chunks.push(stringProperty(name));
    chunks.push(stringProperty("int"));
    chunks.push(stringProperty("Integer"));
    chunks.push(stringProperty(""));
    const integer = new Uint8Array(5);
    integer[0] = 0x49;
    new DataView(integer.buffer).setInt32(1, value, true);
    chunks.push(integer);
    return chunks;
}

function makeBinaryAxisFixture(upAxis, upAxisSign) {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode("Kaydara FBX Binary  \0")];
    chunks.push(...binaryProperty("UpAxis", upAxis));
    chunks.push(...binaryProperty("UpAxisSign", upAxisSign));
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result.buffer;
}

describe("FBX up-axis normalization", () => {
    it("reads binary FBX Z-up metadata", () => {
        expect(readFbxAxisSystem(makeBinaryAxisFixture(2, 1))).toEqual({
            upAxis: 2,
            upAxisSign: 1
        });
    });

    it("reads ASCII FBX axis metadata", () => {
        const text = [
            'P: "UpAxis", "int", "Integer", "",2',
            'P: "UpAxisSign", "int", "Integer", "",1'
        ].join("\n");
        const data = new TextEncoder().encode(text).buffer;
        expect(readFbxAxisSystem(data)).toEqual({ upAxis: 2, upAxisSign: 1 });
    });

    it("maps positive Z-up to positive Y-up", () => {
        const root = new Object3D();
        expect(orientFbxRootToYUp(root, { upAxis: 2, upAxisSign: 1 })).toBe(true);
        const up = new Vector3(0, 0, 1).applyQuaternion(root.quaternion);
        expect(up.x).toBeCloseTo(0, 6);
        expect(up.y).toBeCloseTo(1, 6);
        expect(up.z).toBeCloseTo(0, 6);
    });

    it("leaves positive Y-up files unchanged", () => {
        const root = new Object3D();
        expect(orientFbxRootToYUp(root, { upAxis: 1, upAxisSign: 1 })).toBe(false);
        expect(root.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    });
});
