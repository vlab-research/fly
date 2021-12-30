<script>
    export let field;

    const { properties } = field;
    const { choices } = properties;
    let selectedChoice;
</script>

<div>
    <label for="field-{field.id}" class="field-label">{field.title}</label>
    {#each choices as choice, index (choice.id)}
        <div class="c-cb">
            <input
                type="radio"
                name="choices"
                value={choice.id}
                bind:group={selectedChoice} />
            <label
                for="choice-{choice.id}"
                class="field-label">{choice.label}</label>
        </div>
    {/each}
</div>
