/**
 * Wrap a Comfy/LiteGraph widget callback without narrowing its evolving
 * callback signature. The original context, arguments, and return value are
 * part of the compatibility contract.
 */
export function wrapWidgetCallback(widget, onValue) {
    const original = widget?.callback;
    function wrapped(...args) {
        const result = original?.apply(this, args);
        onValue(args[0]);
        return result;
    }
    widget.callback = wrapped;
    return { original, wrapped };
}
