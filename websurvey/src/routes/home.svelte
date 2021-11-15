<script>
    import Button from "../components/Button.svelte";

    const view = "homepage";
</script>

<div class="surveyapp stack-large">
    <form>
        <div class="stack-small">
            <h1 class="h1">Hey! Welcome to our fun survey</h1>
            <Button on:homepageClick={(e) => console.log(e.detail)} {view} />
        </div>
    </form>
</div>
