<script>
    export let field = {};

    const { title, id, properties } = field;
    const { choices } = properties;
</script>

<!-- Question -->
<div>
    <label for="field-{id}" class="field-label">{title}</label>
    {#each choices as choice, index (choice.id)}
        <div class="c-cb">
            <input type="checkbox" checked={false} />
            <label
                for="field-{choice.id}"
                class="field-label">{choice.label}</label>
        </div>
    {/each}
    <button class="btn">OK</button>
</div>
