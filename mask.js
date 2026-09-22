// Rounded corners for an actor with no background of its own to round, like the blur.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

// Signed distance to a rounded box, one pixel of soft edge. The texture is premultiplied.
const SHADER = `
uniform sampler2D tex;
uniform float width;
uniform float height;
uniform float radius;

void main() {
    vec2 size = vec2(width, height);
    vec2 q = abs(cogl_tex_coord_in[0].xy * size - size * 0.5) - (size * 0.5 - radius);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    cogl_color_out = texture2D(tex, cogl_tex_coord_in[0].xy) * clamp(0.5 - d, 0.0, 1.0);
}`;

export const RoundedMask = GObject.registerClass({
    GTypeName: 'SilverDockRoundedMask',
}, class RoundedMask extends Clutter.ShaderEffect {
    constructor() {
        super();
        this.set_shader_source(SHADER);
        this.set_uniform_value('tex', 0);
    }

    // Every uniform write repaints, most animation steps change nothing here.
    // GJS hands whole numbers over as int, the shader takes floats.
    setShape(width, height, radius) {
        const shape = `${width} ${height} ${radius}`;
        if (shape === this._shape)
            return;
        this._shape = shape;
        for (const [name, value] of Object.entries({width, height, radius}))
            this.set_uniform_value(name, value + 1e-3);
    }
});
