<script>
    import { createEventDispatcher } from "svelte";

    export let field, fieldValue, title;

    const dispatch = createEventDispatcher();
</script>

<div class="space-y-0.5">
    <label
        for="field-{field.id}"
        class="text-lg font-semibold text-slate">{title}</label>
    <input
        bind:value={fieldValue}
        on:input={dispatch('add-field-value', fieldValue)}
        type="text"
        id="field-{field.id}"
        autocomplete="off"
        class="input input__lg"
        placeholder={field.title} />
</div>
