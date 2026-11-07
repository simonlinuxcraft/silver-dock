// St rounds only its own background, not a clone inside it.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

// Rounded box distance over up to three boxes along the bar, one pixel of soft edge on premultiplied color.
const DECLARATIONS = `
uniform float width;
uniform float height;
uniform float radius;
uniform float vertical;
uniform float a0;
uniform float l0;
uniform float a1;
uniform float l1;
uniform float a2;
uniform float l2;

float box(vec2 p, float a, float l) {
    if (l < 1.0)
        return 1e6;
    vec2 c = vertical > 0.5 ? vec2(width * 0.5, a + l * 0.5) : vec2(a + l * 0.5, height * 0.5);
    vec2 h = vertical > 0.5 ? vec2(width * 0.5, l * 0.5) : vec2(l * 0.5, height * 0.5);
    float r = min(radius, min(h.x, h.y));
    vec2 q = abs(p - c) - (h - r);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}`;

const MASK = `
    vec2 p = cogl_tex_coord_in[0].xy * vec2(width, height);
    float d = min(box(p, a0, l0), min(box(p, a1, l1), box(p, a2, l2)));
    cogl_color_out *= clamp(0.5 - d, 0.0, 1.0);`;

// Mutter 51 dropped set_shader_source for a snippet the subclass hands over once.
const SNIPPETS = !Clutter.ShaderEffect.prototype.set_shader_source;

class RoundedMask extends Clutter.ShaderEffect {
    constructor() {
        super();
        if (SNIPPETS)
            return;
        this.set_shader_source(`uniform sampler2D tex;${DECLARATIONS}
void main() {
    cogl_color_out = texture2D(tex, cogl_tex_coord_in[0].xy);${MASK}
}`);
        this.set_uniform_value('tex', 0);
    }

    // spans: [start, length] along the bar. Uniform writes repaint, and GJS passes whole numbers as int.
    setShape(width, height, radius, vertical, spans) {
        const [s0 = [0, 0], s1 = [0, 0], s2 = [0, 0]] = spans;
        const values = {width, height, radius, vertical: Number(vertical),
            a0: s0[0], l0: s0[1], a1: s1[0], l1: s1[1], a2: s2[0], l2: s2[1]};
        const shape = Object.values(values).join(' ');
        if (shape === this._shape)
            return;
        this._shape = shape;
        for (const [name, value] of Object.entries(values))
            this.set_uniform_value(name, value + 1e-3);
    }
}

// Older Clutter has no such vfunc, and registerClass rejects unknown ones.
// defineProperty, since plain assignment looks up the unimplemented parent vfunc and throws.
if (SNIPPETS) {
    Object.defineProperty(RoundedMask.prototype, 'vfunc_get_static_snippet', {
        value: () => Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, MASK),
    });
}

const Registered = GObject.registerClass({GTypeName: 'SilverDockRoundedMask'}, RoundedMask);
export {Registered as RoundedMask};
