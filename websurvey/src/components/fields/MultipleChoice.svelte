<script>
    export let field = {};
    export let index;

    const { title, properties } = field;
    const { choices } = properties;

    let yes = false;
</script>

<!-- Question -->
<div>
    <label class="field-label" for="field-{title}">{title}</label>
    {#each choices as choice, index (choice.id)}
        <div class="c-cb">
            <input id="property-{choice}" type="checkbox" bind:checked={yes} />
            <label
                for="property-{choice}"
                class="field-label">{choice.label}</label>
        </div>
    {/each}
    <button class="btn">OK</button>
</div>
