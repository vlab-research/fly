<script>
    export let field = {};
    const { title, id, properties } = field;
    const { choices } = properties;
</script>

<!-- Question -->
<div>
    <h3>{title}</h3>
    {#each choices as choice, index (choice.id)}
        <div>
            <input type="checkbox" checked={false} />
            <label for="field-{id}">{choice.label}</label>
        </div>
    {/each}
    <button>OK</button>
</div>
